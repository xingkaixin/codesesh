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
            CREATE TABLE IF NOT EXISTS hub_replacements(token_hash TEXT PRIMARY KEY REFERENCES hub_pairing(token_hash) ON DELETE CASCADE,node_id TEXT NOT NULL UNIQUE);
            CREATE TABLE IF NOT EXISTS hub_pairing_results(token_hash TEXT PRIMARY KEY,node_id TEXT NOT NULL,expires_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS hub_nodes(id TEXT PRIMARY KEY,name TEXT NOT NULL,version TEXT NOT NULL,credential_hash TEXT NOT NULL UNIQUE,stream_id TEXT NOT NULL,confirmed_sequence INTEGER NOT NULL DEFAULT 0,confirmed_digest TEXT,confirmed_reference TEXT,recovery_epoch TEXT,paired_at INTEGER NOT NULL,last_seen INTEGER,last_confirmed_at INTEGER,collection_complete INTEGER NOT NULL DEFAULT 0,revoked INTEGER NOT NULL DEFAULT 0,queue TEXT,error TEXT,instance_id TEXT,lease_until INTEGER);
            CREATE TABLE IF NOT EXISTS hub_orphans(node_id TEXT NOT NULL REFERENCES hub_nodes(id),agent TEXT NOT NULL,session_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(node_id,agent,session_id));
            CREATE TABLE IF NOT EXISTS hub_node_health(node_id TEXT PRIMARY KEY REFERENCES hub_nodes(id),payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS hub_ignored_sources(node_id TEXT NOT NULL REFERENCES hub_nodes(id),agent TEXT NOT NULL,PRIMARY KEY(node_id,agent));
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
        self.create_node_pairing_token(None)
    }

    pub fn create_replacement_token(&mut self, node: &str) -> Result<String> {
        self.create_node_pairing_token(Some(node))
    }

    fn create_node_pairing_token(&mut self, node: Option<&str>) -> Result<String> {
        let token = secret();
        let now = chrono::Utc::now().timestamp_millis();
        let tx = self.connection.transaction()?;
        if let Some(node) = node {
            ensure!(tx.query_row("SELECT EXISTS(SELECT 1 FROM hub_nodes WHERE id=? AND id IN (SELECT id FROM hub_control.nodes))", [node], |r| r.get::<_,bool>(0))?, "Unknown node");
            tx.execute("DELETE FROM hub_pairing WHERE token_hash IN (SELECT token_hash FROM hub_replacements WHERE node_id=?)", [node])?;
        }
        tx.execute("DELETE FROM hub_pairing WHERE expires_at<=?", [now])?;
        tx.execute("DELETE FROM hub_pairing_results WHERE expires_at<=?", [now])?;
        tx.execute(
            "INSERT INTO hub_pairing VALUES(?,?)",
            params![digest(token.as_bytes()), now + 10 * 60 * 1000],
        )?;
        if let Some(node) = node {
            tx.execute(
                "INSERT INTO hub_replacements VALUES(?,?)",
                params![digest(token.as_bytes()), node],
            )?;
        }
        tx.commit()?;
        Ok(token)
    }

    pub fn pairing_status(&self, token: &str) -> Result<Option<String>> {
        self.connection
            .query_row(
                "SELECT node_id FROM hub_pairing_results WHERE token_hash=? AND expires_at>?",
                params![
                    digest(token.as_bytes()),
                    chrono::Utc::now().timestamp_millis()
                ],
                |r| r.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn pair_worker(
        &mut self,
        token: &str,
        name: &str,
        version: &str,
        stream_id: &str,
    ) -> Result<PairingGrant> {
        self.pair_worker_with_origin(token, name, version, stream_id, None)
    }

    pub fn configure_local_worker(&mut self, key: &str) -> Result<()> {
        self.connection.execute("INSERT INTO hub_meta VALUES('local_worker_key',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [key])?;
        Ok(())
    }

    pub fn pair_worker_with_origin(
        &mut self,
        token: &str,
        name: &str,
        version: &str,
        stream_id: &str,
        proof: Option<(&str, &str)>,
    ) -> Result<PairingGrant> {
        let local = if let Some((claimed_hub, proof)) = proof {
            let hub_id: String = self.connection.query_row(
                "SELECT value FROM hub_meta WHERE key='hub_id'",
                [],
                |r| r.get(0),
            )?;
            let key: Option<String> = self
                .connection
                .query_row(
                    "SELECT value FROM hub_meta WHERE key='local_worker_key'",
                    [],
                    |r| r.get(0),
                )
                .optional()?;
            if claimed_hub == hub_id {
                ensure!(
                    key.is_some_and(|key| crate::sync::verify_local_worker_proof(
                        &key, &hub_id, token, stream_id, proof
                    )),
                    "Invalid local Worker proof; restart or upgrade Hub and retry"
                );
                true
            } else {
                false
            }
        } else {
            false
        };
        ensure!(
            !name.trim().is_empty() && name.len() <= 128,
            "Invalid node name"
        );
        uuid::Uuid::parse_str(stream_id).context("Invalid upload stream")?;
        let tx = self.connection.transaction()?;
        let replacement: Option<(String, String)> = tx.query_row("SELECT n.id,n.name FROM hub_replacements r JOIN hub_nodes n ON n.id=r.node_id WHERE r.token_hash=?", [digest(token.as_bytes())], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
        if let Some((node, _)) = &replacement {
            ensure!(
                (node == crate::contract::LOCAL_SOURCE_NODE_ID) == local,
                "Replacing the local source requires this Hub's installation proof; remote replacements require a separate Worker data directory"
            );
        }
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
        let node_id = if let Some((node, _)) = &replacement {
            node.clone()
        } else if local {
            crate::contract::LOCAL_SOURCE_NODE_ID.to_owned()
        } else {
            uuid::Uuid::new_v4().to_string()
        };
        let name = replacement
            .as_ref()
            .map(|(_, name)| name.as_str())
            .unwrap_or(name);
        let credential = secret();
        tx.execute(
            "INSERT INTO hub_pairing_results VALUES(?,?,?)",
            params![
                digest(token.as_bytes()),
                node_id,
                chrono::Utc::now().timestamp_millis() + 10 * 60 * 1000
            ],
        )?;
        tx.execute("INSERT INTO hub_nodes(id,name,version,credential_hash,stream_id,paired_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,version=excluded.version,credential_hash=excluded.credential_hash,stream_id=excluded.stream_id,revoked=0,confirmed_sequence=0,confirmed_digest=NULL,confirmed_reference=NULL,recovery_epoch=NULL,instance_id=NULL,lease_until=NULL,queue=NULL,error=NULL,collection_complete=0", params![node_id,name,version,digest(credential.as_bytes()),stream_id,chrono::Utc::now().timestamp_millis()])?;
        if replacement.is_some() {
            tx.execute("DELETE FROM hub_chunks WHERE node_id=?", [&node_id])?;
            tx.execute("DELETE FROM hub_node_health WHERE node_id=?", [&node_id])?;
            tx.execute(
                "DELETE FROM hub_ignored_sources WHERE node_id=?",
                [&node_id],
            )?;
            tx.execute("UPDATE hub_rescans SET status='superseded' WHERE node_id=? AND status IN ('waiting','dispatched','running','paused','uploading')", [&node_id])?;
            let request = crate::sync::RescanRequest {
                id: uuid::Uuid::new_v4().to_string(),
                agents: vec![],
                reason: "worker-replacement".into(),
                required_revisions: crate::agents::catalog(0)
                    .into_iter()
                    .map(|agent| {
                        (
                            agent.name.clone(),
                            crate::agents::parser_version(&agent.name).into(),
                        )
                    })
                    .collect(),
                created_at: chrono::Utc::now().timestamp_millis(),
            };
            tx.execute(
                "INSERT INTO hub_rescans VALUES(?,?,?,'waiting',NULL)",
                params![request.id, node_id, serde_json::to_string(&request)?],
            )?;
        }
        let hub_id = tx.query_row("SELECT value FROM hub_meta WHERE key='hub_id'", [], |r| {
            r.get(0)
        })?;
        let epoch = tx.query_row("SELECT value FROM hub_meta WHERE key='epoch'", [], |r| {
            r.get(0)
        })?;
        tx.execute("INSERT INTO hub_control.nodes(id,name,version,credential_hash,stream_id,paired_at) SELECT id,name,version,credential_hash,stream_id,paired_at FROM hub_nodes WHERE id=? ON CONFLICT(id) DO UPDATE SET name=excluded.name,version=excluded.version,credential_hash=excluded.credential_hash,stream_id=excluded.stream_id,revoked=0",[&node_id])?;
        tx.commit()?;
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
        )? == 1, "WORKER_INSTANCE_CONFLICT: another Worker instance still holds this node lease; waiting for release or expiry (up to 60 seconds)");
        Ok(())
    }

    /// Call only before serving requests, while holding the exclusive Hub process lock.
    pub fn clear_worker_leases(&mut self) -> Result<()> {
        self.connection
            .execute("UPDATE hub_nodes SET instance_id=NULL,lease_until=0", [])?;
        Ok(())
    }

    pub fn release_worker_instance(&mut self, node: &str, instance: &str) -> Result<()> {
        uuid::Uuid::parse_str(instance).context("Invalid Worker instance")?;
        self.connection.execute(
            "UPDATE hub_nodes SET instance_id=NULL,lease_until=0 WHERE id=? AND instance_id=?",
            params![node, instance],
        )?;
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

    /// Hides a missing source's warning until the Worker reports the source again.
    pub fn set_source_ignored(&mut self, node: &str, agent: &str, ignored: bool) -> Result<()> {
        ensure!(
            self.connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM hub_nodes WHERE id=?)",
                [node],
                |r| r.get::<_, bool>(0)
            )?,
            "Unknown node"
        );
        if ignored {
            self.connection.execute(
                "INSERT OR IGNORE INTO hub_ignored_sources VALUES(?,?)",
                params![node, agent],
            )?;
        } else {
            self.connection.execute(
                "DELETE FROM hub_ignored_sources WHERE node_id=? AND agent=?",
                params![node, agent],
            )?;
        }
        Ok(())
    }

    pub fn revoke_worker(&mut self, node: &str) -> Result<()> {
        self.connection.execute("DELETE FROM hub_pairing WHERE token_hash IN (SELECT token_hash FROM hub_replacements WHERE node_id=?)", [node])?;
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
        let mut query=self.connection.prepare("SELECT id,name,version,paired_at,last_seen,revoked,queue,error,(SELECT COUNT(*) FROM hub_orphans WHERE node_id=hub_nodes.id),collection_complete,last_confirmed_at,(SELECT payload FROM hub_node_health WHERE node_id=hub_nodes.id),(SELECT json_group_array(agent) FROM hub_ignored_sources WHERE node_id=hub_nodes.id) FROM hub_nodes ORDER BY paired_at,id")?;
        let rows = query
            .query_map([], |r| {
                Ok((
                    Node {
                        health: None,
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
                        agents: Default::default(),
                        ignored_sources: vec![],
                    },
                    r.get::<_, Option<String>>(6)?,
                    r.get::<_, Option<String>>(11)?,
                    r.get::<_, String>(12)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|(mut node, queue, health, ignored)| {
                node.health = health.map(|raw| serde_json::from_str(&raw)).transpose()?;
                node.ignored_sources = serde_json::from_str(&ignored)?;
                node.queue = queue.map(|raw| serde_json::from_str(&raw)).transpose()?;
                Ok(node)
            })
            .collect()
    }
}
