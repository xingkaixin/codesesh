use super::*;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

fn label(home: &Path, role: ServiceRole) -> String {
    let digest = Sha256::digest(home.to_string_lossy().as_bytes());
    format!(
        "com.codesesh.{}.{}",
        digest[..6]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>(),
        role.name()
    )
}
pub(super) fn environment() -> BTreeMap<String, String> {
    [
        "HOME",
        "USERPROFILE",
        "PATH",
        "APPDATA",
        "LOCALAPPDATA",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
        "CODEX_HOME",
        "AGY_CONVERSATIONS_DIR",
        "CLAUDE_CONFIG_DIR",
        "CURSOR_DATA_PATH",
        "DEEPCHAT_USER_DATA_DIR",
        "CHERRYSTUDIO_USER_DATA_DIR",
        "DSH_HOME",
        "GROK_HOME",
        "KIMI_CODE_HOME",
        "KIMI_SHARE_DIR",
        "MAVIS_DATA_DIR",
        "MINIMAX_DATA_DIR",
        "OPENCODE_DB",
        "PI_HOME",
        "CODESESH_STATE_DIR",
        "CODESESH_LOG_DIR",
        "TZ",
    ]
    .into_iter()
    .filter_map(|key| std::env::var(key).ok().map(|value| (key.to_owned(), value)))
    .collect()
}
#[cfg(any(target_os = "macos", target_os = "windows", test))]
fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
async fn command(program: &str, args: &[&str], required: bool) -> Result<String> {
    let output = tokio::time::timeout(
        Duration::from_secs(15),
        tokio::process::Command::new(program)
            .args(args)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .context("Service manager timed out")??;
    ensure!(
        !required || output.status.success(),
        "{program} failed: {}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    ))
}
#[cfg(any(target_os = "macos", test))]
fn launchd_definition(
    label: &str,
    exe: &Path,
    directory: &Path,
    log: &Path,
    role: ServiceRole,
    environment: &BTreeMap<String, String>,
) -> String {
    let environment = environment
        .iter()
        .map(|(key, value)| format!("<key>{}</key><string>{}</string>", xml(key), xml(value)))
        .collect::<String>();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>{label}</string>
<key>ProgramArguments</key><array><string>{exe}</string><string>--service-run</string><string>{role}</string></array>
<key>WorkingDirectory</key><string>{directory}</string>
<key>EnvironmentVariables</key><dict>{environment}</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>30</integer>
<key>ExitTimeOut</key><integer>60</integer>
<key>StandardOutPath</key><string>{log}</string>
<key>StandardErrorPath</key><string>{log}</string>
</dict></plist>"#,
        label = xml(label),
        exe = xml(&exe.to_string_lossy()),
        directory = xml(&directory.to_string_lossy()),
        role = role.name(),
        log = xml(&log.to_string_lossy())
    )
}
#[cfg(target_os = "macos")]
fn domain() -> String {
    format!("gui/{}", unsafe { libc::geteuid() })
}
#[cfg(target_os = "macos")]
pub async fn start(home: &Path, role: ServiceRole) -> Result<()> {
    let label = label(home, role);
    let file = path(home, role, "plist");
    let config = load(home, role)?;
    write_private(
        &file,
        launchd_definition(
            &label,
            &std::env::current_exe()?,
            &config.directory,
            &path(home, role, "log"),
            role,
            &config.environment,
        )
        .as_bytes(),
    )?;
    stop(home, role).await?;
    command(
        "launchctl",
        &["bootstrap", &domain(), &file.to_string_lossy()],
        true,
    )
    .await?;
    Ok(())
}
#[cfg(target_os = "macos")]
pub async fn stop(home: &Path, role: ServiceRole) -> Result<()> {
    let target = format!("{}/{}", domain(), label(home, role));
    let probe = tokio::process::Command::new("launchctl")
        .args(["print", &target])
        .output()
        .await?;
    if probe.status.success() {
        command("launchctl", &["bootout", &target], true).await?;
    } else {
        ensure!(
            probe.status.code() == Some(113),
            "Cannot inspect launchd service: {}",
            String::from_utf8_lossy(&probe.stderr)
        );
    }
    Ok(())
}
#[cfg(target_os = "macos")]
pub async fn status(home: &Path, role: ServiceRole) -> Result<String> {
    command(
        "launchctl",
        &["print", &format!("{}/{}", domain(), label(home, role))],
        false,
    )
    .await
}

#[cfg(any(target_os = "linux", test))]
fn unit_quote(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('%', "%%")
            .replace('\n', "\\n")
            .replace('\r', "\\r")
    )
}
#[cfg(any(target_os = "linux", test))]
fn systemd_definition(
    exe: &Path,
    directory: &Path,
    log: &Path,
    role: ServiceRole,
    environment: &BTreeMap<String, String>,
) -> String {
    let vars = environment
        .iter()
        .map(|(key, value)| format!("Environment={}\n", unit_quote(&format!("{key}={value}"))))
        .collect::<String>();
    format!(
        "[Unit]\nDescription=CodeSesh {}\nStartLimitIntervalSec=0\n[Service]\nType=simple\nExecStart=:{} --service-run {}\nWorkingDirectory={}\nRestart=on-failure\nRestartSec=30\nTimeoutStopSec=60\n{}StandardOutput=append:{}\nStandardError=append:{}\n",
        role.name(),
        unit_quote(&exe.to_string_lossy()),
        role.name(),
        directory.to_string_lossy().replace('%', "%%"),
        vars,
        log.to_string_lossy().replace('%', "%%"),
        log.to_string_lossy().replace('%', "%%")
    )
}
#[cfg(target_os = "linux")]
pub async fn start(home: &Path, role: ServiceRole) -> Result<()> {
    let name = format!("{}.service", label(home, role));
    let file = root(home).join(&name);
    let config = load(home, role)?;
    for path in [&config.directory, &path(home, role, "log")] {
        let value = path.to_string_lossy();
        ensure!(
            !value.contains(['\n', '\r']) && value.trim() == value,
            "systemd service paths cannot contain line breaks or surrounding whitespace"
        );
    }
    write_private(
        &file,
        systemd_definition(
            &std::env::current_exe()?,
            &config.directory,
            &path(home, role, "log"),
            role,
            &config.environment,
        )
        .as_bytes(),
    )?;
    command(
        "systemctl",
        &["--user", "link", &file.to_string_lossy()],
        true,
    )
    .await?;
    command("systemctl", &["--user", "daemon-reload"], true).await?;
    command("systemctl", &["--user", "start", &name], true).await?;
    Ok(())
}
#[cfg(target_os = "linux")]
pub async fn stop(home: &Path, role: ServiceRole) -> Result<()> {
    let name = format!("{}.service", label(home, role));
    let state = command(
        "systemctl",
        &["--user", "show", &name, "--property=LoadState"],
        false,
    )
    .await?;
    if state.trim() != "LoadState=not-found" {
        command("systemctl", &["--user", "stop", &name], true).await?;
    }
    Ok(())
}
#[cfg(target_os = "linux")]
pub async fn status(home: &Path, role: ServiceRole) -> Result<String> {
    command(
        "systemctl",
        &[
            "--user",
            "show",
            &format!("{}.service", label(home, role)),
            "--property=ActiveState,SubState,Result,MainPID",
        ],
        false,
    )
    .await
}

#[cfg(any(target_os = "windows", test))]
fn task_definition(
    exe: &Path,
    directory: &Path,
    log: &Path,
    role: ServiceRole,
    user: &str,
) -> String {
    use base64::Engine;
    let literal = |value: &Path| format!("'{}'", value.to_string_lossy().replace('\'', "''"));
    let script = format!(
        "& {} --service-run {} >> {} 2>&1; exit $LASTEXITCODE",
        literal(exe),
        role.name(),
        literal(log)
    );
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<Principals><Principal id="User"><UserId>{user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>false</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>true</Hidden><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure></Settings>
<Actions Context="User"><Exec><Command>powershell.exe</Command><Arguments>-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand {encoded}</Arguments><WorkingDirectory>{directory}</WorkingDirectory></Exec></Actions>
</Task>"#,
        user = xml(user),
        directory = xml(&directory.to_string_lossy())
    )
}
#[cfg(target_os = "windows")]
pub async fn start(home: &Path, role: ServiceRole) -> Result<()> {
    let config = load(home, role)?;
    let file = path(home, role, "xml");
    let user = format!(
        "{}\\{}",
        std::env::var("USERDOMAIN")?,
        std::env::var("USERNAME")?
    );
    let definition = task_definition(
        &std::env::current_exe()?,
        &config.directory,
        &path(home, role, "log"),
        role,
        &user,
    );
    let mut bytes = vec![0xff, 0xfe];
    for ch in definition.encode_utf16() {
        bytes.extend(ch.to_le_bytes());
    }
    write_private(&file, &bytes)?;
    command(
        "schtasks.exe",
        &[
            "/Create",
            "/TN",
            &label(home, role),
            "/XML",
            &file.to_string_lossy(),
            "/F",
        ],
        true,
    )
    .await?;
    command("schtasks.exe", &["/Run", "/TN", &label(home, role)], true).await?;
    Ok(())
}
#[cfg(target_os = "windows")]
pub async fn stop(home: &Path, role: ServiceRole) -> Result<()> {
    let name = label(home, role);
    let script = format!(
        "$ErrorActionPreference='Stop'; $task=Get-ScheduledTask -TaskName '{name}' -ErrorAction SilentlyContinue; if ($task) {{ Disable-ScheduledTask -InputObject $task | Out-Null; if ((Get-ScheduledTask -TaskName '{name}').State -eq 'Running') {{ throw 'Service is still running; graceful stop could not be confirmed. Check the service log.' }} }}"
    );
    command(
        "powershell.exe",
        &["-NoProfile", "-NonInteractive", "-Command", &script],
        true,
    )
    .await?;
    Ok(())
}
#[cfg(target_os = "windows")]
pub async fn status(home: &Path, role: ServiceRole) -> Result<String> {
    command(
        "schtasks.exe",
        &["/Query", "/TN", &label(home, role), "/FO", "LIST", "/V"],
        false,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn service_definitions_preserve_literal_paths_without_shell_interpretation() {
        let exe = Path::new("/space & quote\"/100%/codesesh");
        let env = BTreeMap::from([("CODEX_HOME".into(), "/history & private".into())]);
        let plist = launchd_definition(
            "test",
            exe,
            Path::new("/tmp"),
            Path::new("/tmp/log"),
            ServiceRole::Hub,
            &env,
        );
        assert!(plist.contains("/space &amp; quote&quot;/100%/codesesh"));
        let unit = systemd_definition(
            exe,
            Path::new("/tmp"),
            Path::new("/tmp/log"),
            ServiceRole::Hub,
            &env,
        );
        assert!(
            unit.contains("ExecStart=:\"/space & quote\\\"/100%%/codesesh\" --service-run hub")
        );
        assert!(unit.contains("StandardOutput=append:/tmp/log\n"));
        assert!(unit.contains("WorkingDirectory=/tmp\n"));
        let task = task_definition(
            exe,
            Path::new("/tmp"),
            Path::new("/tmp/log"),
            ServiceRole::Worker,
            "user&name",
        );
        assert!(task.contains("<UserId>user&amp;name</UserId>"));
        assert!(task.contains("<AllowHardTerminate>false</AllowHardTerminate>"));
        assert!(!environment().keys().any(|key| key.contains("TOKEN")));
    }
}
