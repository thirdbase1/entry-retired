//! Integration plugin registry (Phase 3).
//!
//! Everything is a plugin: the model provider and each integration
//! (GitHub, Vercel, Bachs billing) implement the same `IntegrationPlugin`
//! contract and register in one place. Plugins expose descriptors to the
//! UI (id, name, logo, connected state) and are the only path the agent
//! takes to reach an external service.
//!
//! Credential rule (mirrors upstream): plugins never hold secrets. GitHub
//! and Vercel calls go through the Vercel backend proxy, which mints
//! scoped tokens server-side. Only the model plugin reads local env
//! config (its own "bring your own gateway" credentials).

use serde::Serialize;

/// Everything a plugin must tell the UI to render itself.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDescriptor {
    pub id: String,
    pub name: String,
    /// Path to the bundled logo asset (frontend resolves it).
    pub logo: String,
    pub capabilities: Vec<String>,
    /// Whether credentials/connection exist right now.
    pub connected: bool,
    /// Human-readable reason when not connected.
    pub detail: Option<String>,
    /// Where the user goes to connect (opened in system browser).
    pub connect_url: Option<String>,
}

/// The uniform plugin contract. "Everything is a plugin" — the model
/// provider and every integration implement this, so the registry can
/// list, gate, and route them without special cases.
pub trait IntegrationPlugin: Send + Sync {
    fn descriptor(&self) -> PluginDescriptor;
}

// ---------------------------------------------------------------------------
// Model provider plugin (local gateway credentials)
// ---------------------------------------------------------------------------

pub struct ModelProviderIntegration;

impl IntegrationPlugin for ModelProviderIntegration {
    fn descriptor(&self) -> PluginDescriptor {
        let base = std::env::var("ENTRY_MODEL_BASE_URL").ok();
        let model = std::env::var("ENTRY_MODEL_ID").ok();
        let has_key = std::env::var("ENTRY_MODEL_API_KEY")
            .map(|v| !v.is_empty())
            .unwrap_or(false);
        let connected = base.is_some() && model.is_some();
        PluginDescriptor {
            id: "model.openai-compatible".into(),
            name: "Model gateway".into(),
            logo: "logos/entry.svg".into(),
            capabilities: vec![
                "model.chat".into(),
                "network.connect".into(),
                "network.reconnect".into(),
            ],
            connected,
            detail: if connected {
                Some(format!(
                    "{} · key {}",
                    model.unwrap_or_default(),
                    if has_key { "set" } else { "not set" }
                ))
            } else {
                Some("Set ENTRY_MODEL_BASE_URL and ENTRY_MODEL_ID".into())
            },
            connect_url: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Integration plugins (proxied through the Vercel backend)
// ---------------------------------------------------------------------------

pub struct BackendConfig {
    pub base_url: String,
}

impl BackendConfig {
    pub fn from_env() -> Self {
        Self {
            base_url: std::env::var("ENTRY_BACKEND_URL")
                .unwrap_or_else(|_| "https://open-agents.dev".to_string()),
        }
    }
}

pub struct GitHubIntegration;

impl IntegrationPlugin for GitHubIntegration {
    fn descriptor(&self) -> PluginDescriptor {
        let backend = BackendConfig::from_env();
        let token = std::env::var("GITHUB_TOKEN").ok().filter(|t| !t.is_empty());
        PluginDescriptor {
            id: "integration.github".into(),
            name: "GitHub".into(),
            logo: "logos/github.svg".into(),
            capabilities: vec![
                "github.repo.read".into(),
                "github.repo.write".into(),
                "github.pull_request".into(),
                "github.app.install".into(),
            ],
            connected: token.is_some(),
            detail: if token.is_some() {
                Some("Personal access token configured".into())
            } else {
                Some("Sign in with GitHub to connect repositories".into())
            },
            // Desktop opens this in the system browser (cookie session).
            connect_url: Some(format!("{}/api/github/app/install", backend.base_url)),
        }
    }
}

pub struct VercelIntegration;

impl IntegrationPlugin for VercelIntegration {
    fn descriptor(&self) -> PluginDescriptor {
        let backend = BackendConfig::from_env();
        PluginDescriptor {
            id: "integration.vercel".into(),
            name: "Vercel".into(),
            logo: "logos/vercel.svg".into(),
            capabilities: vec![
                "vercel.projects.list".into(),
                "vercel.deployments.read".into(),
                "vercel.env.read".into(),
            ],
            // Connection state is server-side (OAuth token held encrypted
            // in the web DB); the desktop asks the backend for status.
            connected: false,
            detail: Some("Sign in with Vercel to link projects".into()),
            connect_url: Some(format!(
                "{}/api/auth/sign-in/social?provider=vercel",
                backend.base_url
            )),
        }
    }
}

pub struct BillingIntegration;

impl IntegrationPlugin for BillingIntegration {
    fn descriptor(&self) -> PluginDescriptor {
        let backend = BackendConfig::from_env();
        PluginDescriptor {
            id: "integration.billing".into(),
            name: "Billing".into(),
            logo: "logos/entry.svg".into(),
            // Desktop is read-only for billing: it shows plan + balance and
            // hands checkout off to the browser. No subscription logic here.
            capabilities: vec!["billing.balance.read".into()],
            connected: true,
            detail: Some("Managed in the browser · Bachs".into()),
            connect_url: Some(format!("{}/billing", backend.base_url)),
        }
    }
}

/// The registry: every plugin the runtime knows about. Adding a plugin is
/// one entry here plus one file implementing the trait.
pub fn all_plugins() -> Vec<PluginDescriptor> {
    vec![
        ModelProviderIntegration.descriptor(),
        GitHubIntegration.descriptor(),
        VercelIntegration.descriptor(),
        BillingIntegration.descriptor(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_lists_every_plugin() {
        let plugins = all_plugins();
        assert_eq!(plugins.len(), 4);
        let ids: Vec<&str> = plugins.iter().map(|p| p.id.as_str()).collect();
        assert!(ids.contains(&"model.openai-compatible"));
        assert!(ids.contains(&"integration.github"));
        assert!(ids.contains(&"integration.vercel"));
        assert!(ids.contains(&"integration.billing"));
    }

    #[test]
    fn github_plugin_points_at_the_install_route() {
        let gh = GitHubIntegration.descriptor();
        assert!(gh
            .connect_url
            .as_deref()
            .unwrap_or_default()
            .ends_with("/api/github/app/install"));
        assert_eq!(gh.logo, "logos/github.svg");
    }

    #[test]
    fn vercel_plugin_uses_social_sign_in_and_has_a_logo() {
        let v = VercelIntegration.descriptor();
        assert!(v
            .connect_url
            .as_deref()
            .unwrap_or_default()
            .contains("provider=vercel"));
        assert_eq!(v.logo, "logos/vercel.svg");
    }

    #[test]
    fn billing_is_read_only_on_desktop() {
        let b = BillingIntegration.descriptor();
        assert_eq!(b.capabilities, vec!["billing.balance.read".to_string()]);
    }
}
