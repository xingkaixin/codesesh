use anyhow::{Context, Result, ensure};
use reqwest::{Client, header::HeaderMap};
use std::{net::IpAddr, time::Duration};

pub(super) fn hub_url(value: &str) -> Result<url::Url> {
    let url = url::Url::parse(value).context("Invalid Hub URL")?;
    ensure!(
        url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && url.path() == "/"
            && url.host_str().is_some(),
        "Hub URL must contain only the origin, without credentials or a path"
    );
    ensure!(
        matches!(url.scheme(), "http" | "https"),
        "Hub URL must use HTTP or HTTPS"
    );
    Ok(url)
}

fn local_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => ip.is_loopback() || ip.is_private() || ip.is_link_local(),
        IpAddr::V6(ip) => ip.to_ipv4_mapped().map_or_else(
            || ip.is_loopback() || ip.is_unique_local() || ip.is_unicast_link_local(),
            |ip| local_address(IpAddr::V4(ip)),
        ),
    }
}

pub(super) async fn client(origin: &url::Url, headers: HeaderMap) -> Result<Client> {
    let mut builder = Client::builder()
        .default_headers(headers)
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none());
    if origin.scheme() == "http" {
        let host = origin
            .host_str()
            .context("Hub URL requires a host")?
            .trim_matches(['[', ']']);
        let addresses = tokio::time::timeout(
            Duration::from_secs(5),
            tokio::net::lookup_host((host, origin.port_or_known_default().unwrap())),
        )
        .await
        .context("Timed out resolving the Hub address")??
        .collect::<Vec<_>>();
        ensure!(
            !addresses.is_empty() && addresses.iter().all(|address| local_address(address.ip())),
            "HTTP is allowed only for loopback or private LAN addresses. Use HTTPS for a public Hub."
        );
        // Pin validated DNS results and bypass proxies so HTTP credentials stay on the selected local network.
        builder = builder.no_proxy().resolve_to_addrs(host, &addresses);
    }
    Ok(builder.build()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_address_scope_excludes_public_and_unspecified_addresses() {
        for address in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.1.2",
            "192.168.1.2",
            "169.254.2.3",
            "::1",
            "fd00::1",
            "fe80::1",
            "::ffff:192.168.1.2",
        ] {
            assert!(local_address(address.parse().unwrap()), "{address}");
        }
        for address in [
            "0.0.0.0",
            "8.8.8.8",
            "172.32.0.1",
            "192.0.2.1",
            "::",
            "2001:4860:4860::8888",
            "::ffff:8.8.8.8",
            "ff02::1",
        ] {
            assert!(!local_address(address.parse().unwrap()), "{address}");
        }
    }

    #[tokio::test]
    async fn public_http_is_rejected_before_credentials_are_sent() {
        let origin = hub_url("http://8.8.8.8:4521").unwrap();
        assert!(
            client(&origin, HeaderMap::new())
                .await
                .unwrap_err()
                .to_string()
                .contains("Use HTTPS")
        );
        assert!(
            client(&hub_url("http://localhost:4521").unwrap(), HeaderMap::new())
                .await
                .is_ok()
        );
        assert!(
            client(
                &hub_url("https://history.example.com").unwrap(),
                HeaderMap::new()
            )
            .await
            .is_ok()
        );
        for value in [
            "file:///tmp/hub",
            "http://user:secret@localhost",
            "http://localhost/path",
            "http://localhost/?token=x",
        ] {
            assert!(hub_url(value).is_err());
        }
    }
}
