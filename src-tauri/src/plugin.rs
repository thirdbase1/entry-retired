use std::sync::Arc;

use crate::{
    network::{ChatMessage, ModelClient},
    runtime::LocalRuntimePlugin,
};

pub trait Plugin: Send + Sync {
    fn id(&self) -> &'static str;
    fn capabilities(&self) -> &'static [&'static str];
}

pub struct ModelProviderPlugin {
    pub client: ModelClient,
}

impl ModelProviderPlugin {
    pub fn from_env() -> Result<Self, String> {
        Ok(Self {
            client: ModelClient::from_env()?,
        })
    }
}

impl Plugin for ModelProviderPlugin {
    fn id(&self) -> &'static str {
        "model.openai-compatible"
    }
    fn capabilities(&self) -> &'static [&'static str] {
        &["model.chat", "network.connect", "network.reconnect"]
    }
}

pub struct PluginRegistry {
    pub local_runtime: Arc<LocalRuntimePlugin>,
    pub model_provider: Arc<ModelProviderPlugin>,
}

impl PluginRegistry {
    pub fn new(workspace: std::path::PathBuf) -> Result<Self, String> {
        Ok(Self {
            local_runtime: Arc::new(LocalRuntimePlugin::new(workspace)),
            model_provider: Arc::new(ModelProviderPlugin::from_env()?),
        })
    }

    pub fn descriptors(&self) -> Vec<(&'static str, Vec<&'static str>)> {
        vec![
            (
                self.local_runtime.id(),
                self.local_runtime.capabilities().to_vec(),
            ),
            (
                self.model_provider.id(),
                self.model_provider.capabilities().to_vec(),
            ),
        ]
    }

    pub async fn chat(
        &self,
        messages: &[ChatMessage],
        tools: &[serde_json::Value],
    ) -> Result<ChatMessage, String> {
        self.model_provider.client.chat(messages, tools).await
    }
}
