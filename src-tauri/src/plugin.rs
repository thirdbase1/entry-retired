use std::sync::Arc;

use crate::runtime::LocalRuntimePlugin;

pub trait Plugin: Send + Sync {
    fn id(&self) -> &'static str;
    fn capabilities(&self) -> &'static [&'static str];
}

pub struct PluginRegistry {
    pub local_runtime: Arc<LocalRuntimePlugin>,
}

impl PluginRegistry {
    pub fn new(workspace: std::path::PathBuf) -> Self {
        Self {
            local_runtime: Arc::new(LocalRuntimePlugin::new(workspace)),
        }
    }

    pub fn descriptors(&self) -> Vec<(&'static str, &'static [&'static str])> {
        vec![(self.local_runtime.id(), self.local_runtime.capabilities())]
    }
}
