use super::Progress;
use anyhow::{Result, bail, ensure};
use rusqlite::{
    Connection, OpenFlags,
    backup::{Backup, StepResult},
    types::ValueRef,
};
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    time::{Duration, Instant},
};

pub(super) fn copy(source: &Path, target: &Path, report: &mut impl FnMut(Progress)) -> Result<()> {
    let input = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    input.busy_timeout(Duration::from_secs(5))?;
    input.execute_batch("BEGIN;")?;
    let version: i64 = input.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let mut output = Connection::open(target)?;
    {
        let backup = Backup::new(&input, &mut output)?;
        let mut blocked = None;
        loop {
            let step = backup.step(256)?;
            let progress = backup.progress();
            report(Progress::new(
                "Migrating",
                source,
                (progress.pagecount - progress.remaining).max(0) as u64,
                Some(progress.pagecount.max(0) as u64),
            ));
            match step {
                StepResult::Done => break,
                StepResult::More => blocked = None,
                _ => {
                    let since = blocked.get_or_insert_with(Instant::now);
                    ensure!(
                        since.elapsed() < Duration::from_secs(5),
                        "Database busy; stop the older CodeSesh instance: {}",
                        source.display()
                    );
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        }
    }
    report(Progress::new("Checking integrity", source, 0, None));
    let mut statement = output.prepare("PRAGMA integrity_check")?;
    let checks = statement
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    ensure!(
        checks == ["ok"],
        "Database integrity check failed: {}: {:?}",
        source.display(),
        checks
    );
    drop(statement);
    let target_version: i64 = output.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    ensure!(
        version == target_version,
        "Database schema version changed during backup"
    );
    ensure!(
        contents(&input, source, report)? == contents(&output, target, report)?,
        "Database content verification failed: {}",
        source.display()
    );
    input.execute_batch("ROLLBACK")?;
    output.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;")?;
    output.close().map_err(|(_, e)| e)?;
    input.close().map_err(|(_, e)| e)?;
    Ok(())
}

fn contents(db: &Connection, path: &Path, report: &mut impl FnMut(Progress)) -> Result<Vec<u8>> {
    let mut digest = Sha256::new();
    let schema = db
        .prepare(
            "SELECT type,name,tbl_name,coalesce(sql,'') FROM sqlite_schema ORDER BY type,name",
        )?
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for row in &schema {
        digest.update(serde_json::to_vec(row)?);
    }
    let tables: Vec<_> = schema.iter().filter(|r| r.0 == "table").collect();
    for (index, table) in tables.iter().enumerate() {
        let name = table.1.replace('"', "\"\"");
        let mut statement = db.prepare(&format!("SELECT * FROM \"{name}\""))?;
        let columns = statement.column_count();
        if columns == 0 {
            bail!("Table without columns: {name}");
        }
        drop(statement);
        let order = (1..=columns)
            .map(|n| n.to_string())
            .collect::<Vec<_>>()
            .join(",");
        statement = db.prepare(&format!("SELECT * FROM \"{name}\" ORDER BY {order}"))?;
        let total: i64 = db.query_row(&format!("SELECT count(*) FROM \"{name}\""), [], |r| {
            r.get(0)
        })?;
        let mut rows = statement.query([])?;
        let mut done = 0;
        report(Progress::new(
            "Verifying rows",
            path,
            done,
            Some(total as u64),
        ));
        while let Some(row) = rows.next()? {
            for column in 0..columns {
                match row.get_ref(column)? {
                    ValueRef::Null => digest.update([0]),
                    ValueRef::Integer(n) => {
                        digest.update([1]);
                        digest.update(n.to_le_bytes());
                    }
                    ValueRef::Real(n) => {
                        digest.update([2]);
                        digest.update(n.to_bits().to_le_bytes());
                    }
                    ValueRef::Text(b) | ValueRef::Blob(b) => {
                        digest.update([if matches!(row.get_ref(column)?, ValueRef::Text(_)) {
                            3
                        } else {
                            4
                        }]);
                        digest.update((b.len() as u64).to_le_bytes());
                        digest.update(b);
                    }
                }
            }
            done += 1;
            if done % 256 == 0 || done == total as u64 {
                report(Progress::new(
                    "Verifying rows",
                    path,
                    done,
                    Some(total as u64),
                ));
            }
        }
        digest.update((index as u64).to_le_bytes());
        digest.update(done.to_le_bytes());
    }
    Ok(digest.finalize().to_vec())
}
