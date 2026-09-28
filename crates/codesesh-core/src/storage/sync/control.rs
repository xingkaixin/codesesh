use super::*;

fn secret() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

impl Cache {
    pub fn initialize_hub(&mut self, hub_id: &str) -> Result<String> {
        let attached: i64 = self.connection.query_row(
            "SELECT COUNT(*) FROM pragma_database_list WHERE name='hub_control'",
            [],
            |r| r.get(0),
        )?;
        if attached == 0 {
            let registry = self
                .connection
                .path()
                .filter(|path| !path.is_empty())
                .map(|path| std::path::Path::new(path).with_file_name("hub-control.db"));
            if let Some(path) = &registry {
                let mut options = std::fs::OpenOptions::new();
                options.create(true).write(true).truncate(false);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                options.open(path)?;
            }
            self.connection.execute(
                "ATTACH DATABASE ? AS hub_control",
                [registry
                    .as_ref()
                    .map(|path| path.to_string_lossy().into_owned())
                    .unwrap_or_else(|| ":memory:".into())],
            )?;
            let registry_version: i64 =
                self.connection
                    .query_row("PRAGMA hub_control.user_version", [], |r| r.get(0))?;
            ensure!(
                (0..=1).contains(&registry_version),
                "Unsupported Hub registry schema {registry_version}"
            );
            self.connection.execute_batch("PRAGMA hub_control.synchronous=FULL; PRAGMA hub_control.user_version=1; CREATE TABLE IF NOT EXISTS hub_control.identity(id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS hub_control.nodes(id TEXT PRIMARY KEY,name TEXT NOT NULL,version TEXT NOT NULL,credential_hash TEXT NOT NULL UNIQUE,stream_id TEXT NOT NULL,paired_at INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);")?;
            let previous: Option<String> = self
                .connection
                .query_row("SELECT id FROM hub_control.identity", [], |r| r.get(0))
                .optional()?;
            ensure!(
                previous
                    .as_deref()
                    .is_none_or(|previous| previous == hub_id),
                "Hub registry belongs to another identity"
            );
            self.connection.execute(
                "INSERT OR IGNORE INTO hub_control.identity VALUES(?)",
                [hub_id],
            )?;
        }
        let tx = self.connection.transaction()?;
        tx.execute_batch("CREATE TABLE IF NOT EXISTS hub_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS hub_pairing(token_hash TEXT PRIMARY KEY,expires_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS hub_nodes(id TEXT PRIMARY KEY,name TEXT NOT NULL,version TEXT NOT NULL,credential_hash TEXT NOT NULL UNIQUE,stream_id TEXT NOT NULL,confirmed_sequence INTEGER NOT NULL DEFAULT 0,confirmed_digest TEXT,confirmed_reference TEXT,recovery_epoch TEXT,paired_at INTEGER NOT NULL,last_seen INTEGER,last_confirmed_at INTEGER,collection_complete INTEGER NOT NULL DEFAULT 0,revoked INTEGER NOT NULL DEFAULT 0,queue TEXT,error TEXT,instance_id TEXT,lease_until INTEGER);
            CREATE TABLE IF NOT EXISTS hub_orphans(node_id TEXT NOT NULL REFERENCES hub_nodes(id),agent TEXT NOT NULL,session_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(node_id,agent,session_id));
            CREATE TABLE IF NOT EXISTS hub_rescans(id TEXT PRIMARY KEY,node_id TEXT NOT NULL REFERENCES hub_nodes(id),request TEXT NOT NULL,status TEXT NOT NULL,progress TEXT);
            CREATE TABLE IF NOT EXISTS hub_chunks(node_id TEXT NOT NULL REFERENCES hub_nodes(id),stream_id TEXT NOT NULL,transfer_id TEXT NOT NULL,chunk_index INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(node_id,stream_id,transfer_id,chunk_index));")?;
        tx.execute(
            "INSERT OR IGNORE INTO hub_meta VALUES('hub_id',?)",
            [hub_id],
        )?;
        let existing: String =
            tx.query_row("SELECT value FROM hub_meta WHERE key='hub_id'", [], |r| {
                r.get(0)
            })?;
        ensure!(
            existing == hub_id,
            "Hub database belongs to a different installation"
        );
        tx.execute(
            "INSERT OR IGNORE INTO hub_meta VALUES('epoch',?)",
            [uuid::Uuid::new_v4().to_string()],
        )?;
        let epoch = tx.query_row("SELECT value FROM hub_meta WHERE key='epoch'", [], |r| {
            r.get(0)
        })?;
        tx.execute("INSERT OR IGNORE INTO hub_nodes(id,name,version,credential_hash,stream_id,paired_at,revoked) SELECT id,name,version,credential_hash,stream_id,paired_at,revoked FROM hub_control.nodes",[])?;
        tx.execute("UPDATE hub_nodes SET name=(SELECT name FROM hub_control.nodes WHERE id=hub_nodes.id),revoked=(SELECT revoked FROM hub_control.nodes WHERE id=hub_nodes.id) WHERE id IN (SELECT id FROM hub_control.nodes)",[])?;
        tx.commit()?;
        Ok(epoch)
    }

    pub fn create_pairing_token(&mut self) -> Result<String> {
        let token = secret();
        let now = chrono::Utc::now().timestamp_millis();
        let tx = self.connection.transaction()?;
        tx.execute("DELETE FROM hub_pairing WHERE expires_at<=?", [now])?;
        tx.execute(
            "INSERT INTO hub_pairing VALUES(?,?)",
            params![digest(token.as_bytes()), now + 10 * 60 * 1000],
        )?;
        tx.commit()?;
        Ok(token)
    }

    pub fn pair_worker(
        &mut self,
        token: &str,
        name: &str,
        version: &str,
        stream_id: &str,
    ) -> Result<PairingGrant> {
        ensure!(
            !name.trim().is_empty() && name.len() <= 128,
            "Invalid node name"
        );
        uuid::Uuid::parse_str(stream_id).context("Invalid upload stream")?;
        let tx = self.connection.transaction()?;
        let used = tx.execute(
            "DELETE FROM hub_pairing WHERE token_hash=? AND expires_at>?",
            params![
                digest(token.as_bytes()),
                chrono::Utc::now().timestamp_millis()
            ],
        )?;
        ensure!(
            used == 1,
            "Pairing token is invalid, expired, or already used"
        );
        let node_id = uuid::Uuid::new_v4().to_string();
        let credential = secret();
        tx.execute("INSERT INTO hub_nodes(id,name,version,credential_hash,stream_id,paired_at) VALUES(?,?,?,?,?,?)", params![node_id,name,version,digest(credential.as_bytes()),stream_id,chrono::Utc::now().timestamp_millis()])?;
        let hub_id = tx.query_row("SELECT value FROM hub_meta WHERE key='hub_id'", [], |r| {
            r.get(0)
        })?;
        let epoch = tx.query_row("SELECT value FROM hub_meta WHERE key='epoch'", [], |r| {
            r.get(0)
        })?;
        tx.commit()?;
        self.connection.execute("INSERT INTO hub_control.nodes(id,name,version,credential_hash,stream_id,paired_at) SELECT id,name,version,credential_hash,stream_id,paired_at FROM hub_nodes WHERE id=?",[&node_id])?;
        Ok(PairingGrant {
            node_id,
            credential,
            hub_id,
            epoch,
        })
    }

    pub fn authenticate_worker(&self, credential: &str) -> Result<String> {
        self.connection
            .query_row(
                "SELECT id FROM hub_control.nodes WHERE credential_hash=? AND revoked=0",
                [digest(credential.as_bytes())],
                |r| r.get(0),
            )
            .optional()?
            .context("Worker credential is invalid or revoked")
    }

    pub fn claim_worker_instance(&mut self, node: &str, instance: &str) -> Result<()> {
        uuid::Uuid::parse_str(instance).context("Invalid Worker instance")?;
        let now = chrono::Utc::now().timestamp_millis();
        ensure!(self.connection.execute(
            "UPDATE hub_nodes SET instance_id=?,lease_until=? WHERE id=? AND (instance_id IS NULL OR instance_id=? OR lease_until<=?)",
            params![instance, now + 60_000, node, instance, now],
        )? == 1, "WORKER_INSTANCE_CONFLICT: another process owns this node; stop the duplicate and wait 60 seconds");
        Ok(())
    }

    pub fn rename_worker(&mut self, node: &str, name: &str) -> Result<()> {
        ensure!(
            !name.trim().is_empty() && name.len() <= 128,
            "Invalid node name"
        );
        self.connection.execute(
            "UPDATE hub_control.nodes SET name=? WHERE id=?",
            params![name.trim(), node],
        )?;
        ensure!(
            self.connection.execute(
                "UPDATE hub_nodes SET name=? WHERE id=?",
                params![name.trim(), node]
            )? == 1,
            "Unknown node"
        );
        Ok(())
    }

    pub fn revoke_worker(&mut self, node: &str) -> Result<()> {
        self.connection
            .execute("UPDATE hub_control.nodes SET revoked=1 WHERE id=?", [node])?;
        ensure!(
            self.connection
                .execute("UPDATE hub_nodes SET revoked=1 WHERE id=?", [node])?
                == 1,
            "Unknown node"
        );
        Ok(())
    }

    pub fn nodes(&self) -> Result<Vec<Node>> {
        let mut query=self.connection.prepare("SELECT id,name,version,paired_at,last_seen,revoked,queue,error,(SELECT COUNT(*) FROM hub_orphans WHERE node_id=hub_nodes.id),collection_complete,last_confirmed_at FROM hub_nodes ORDER BY paired_at,id")?;
        let rows = query
            .query_map([], |r| {
                Ok((
                    Node {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        version: r.get(2)?,
                        paired_at: r.get(3)?,
                        last_seen: r.get(4)?,
                        last_confirmed_at: r.get(10)?,
                        revoked: r.get(5)?,
                        queue: None,
                        error: r.get(7)?,
                        incomplete_sessions: r.get(8)?,
                        collection_complete: r.get(9)?,
                    },
                    r.get::<_, Option<String>>(6)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|(mut node, queue)| {
                node.queue = queue.map(|raw| serde_json::from_str(&raw)).transpose()?;
                Ok(node)
            })
            .collect()
    }
}
