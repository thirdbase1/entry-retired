use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

#[derive(Clone)]
pub struct ModelClient {
    client: Client,
    base_url: String,
    api_key: Option<String>,
    model: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub function: FunctionCall,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FunctionCall {
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Serialize)]
struct Request<'a> {
    model: &'a str,
    messages: &'a [ChatMessage],
    tools: &'a [Value],
    tool_choice: &'static str,
}

#[derive(Debug, Deserialize)]
struct Response {
    choices: Vec<Choice>,
}

#[derive(Debug, Deserialize)]
struct Choice {
    message: ChatMessage,
}

impl ModelClient {
    pub fn from_env() -> Result<Self, String> {
        let base_url = std::env::var("ENTRY_MODEL_BASE_URL")
            .map_err(|_| "ENTRY_MODEL_BASE_URL is not configured.".to_string())?
            .trim_end_matches('/')
            .to_string();
        let model = std::env::var("ENTRY_MODEL_ID")
            .map_err(|_| "ENTRY_MODEL_ID is not configured.".to_string())?;
        let api_key = std::env::var("ENTRY_MODEL_API_KEY")
            .ok()
            .filter(|v| !v.is_empty());
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(90))
            .pool_idle_timeout(Duration::from_secs(30))
            .tcp_keepalive(Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            client,
            base_url,
            api_key,
            model,
        })
    }

    pub async fn chat(
        &self,
        messages: &[ChatMessage],
        tools: &[Value],
    ) -> Result<ChatMessage, String> {
        let request = Request {
            model: &self.model,
            messages,
            tools,
            tool_choice: "auto",
        };
        let mut last_error = "network request failed".to_string();

        for attempt in 0..4 {
            let mut builder = self
                .client
                .post(format!("{}/chat/completions", self.base_url))
                .json(&request);
            if let Some(key) = &self.api_key {
                builder = builder.bearer_auth(key);
            }

            match builder.send().await {
                Ok(response) => {
                    if response.status().is_success() {
                        let body: Response = response.json().await.map_err(|e| e.to_string())?;
                        return body
                            .choices
                            .into_iter()
                            .next()
                            .map(|c| c.message)
                            .ok_or_else(|| "Model returned no choices.".to_string());
                    }
                    let status = response.status();
                    let body = response.text().await.unwrap_or_default();
                    last_error = format!("model HTTP {}: {}", status, truncate_error(&body));
                    if !retryable(status) {
                        break;
                    }
                }
                Err(error) => {
                    last_error = error.to_string();
                }
            }

            if attempt < 3 {
                let delay = Duration::from_millis(700u64.saturating_mul(2u64.pow(attempt)));
                tokio::time::sleep(delay).await;
            }
        }

        Err(format!(
            "MODEL_NETWORK_ERROR: {}. The task state is preserved; retry/resume is safe.",
            last_error
        ))
    }
}

fn retryable(status: StatusCode) -> bool {
    matches!(
        status.as_u16(),
        408 | 409 | 425 | 429 | 500 | 502 | 503 | 504
    )
}

fn truncate_error(body: &str) -> String {
    body.chars().take(500).collect()
}
