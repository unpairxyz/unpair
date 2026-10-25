use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("missing environment variable {0}")]
    Missing(&'static str),
    #[error("invalid value for {0}: {1}")]
    Invalid(String, String),
}

/// Errors returned to API callers. Messages are plain words, safe to show.
#[derive(Debug, Error)]
pub enum ApiError {
    #[error("{0}")]
    BadRequest(String),
    #[error("not allowed: {0}")]
    Forbidden(String),
    #[error("the route is not reachable right now")]
    Upstream(String),
    #[error("screening is not reachable right now")]
    ScreeningUnavailable(String),
    #[error("not found")]
    NotFound,
    #[error("not authorized")]
    Unauthorized,
    #[error("hosted swaps are not offered by this server")]
    HostedOff,
    #[error("internal error")]
    Internal(String),
}

#[derive(Serialize)]
struct ErrorBody<'a> {
    error: &'a str,
    message: String,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code) = match &self {
            ApiError::BadRequest(_) => (StatusCode::BAD_REQUEST, "bad_request"),
            ApiError::Forbidden(_) => (StatusCode::FORBIDDEN, "forbidden"),
            ApiError::Upstream(_) => (StatusCode::BAD_GATEWAY, "upstream"),
            ApiError::ScreeningUnavailable(_) => {
                (StatusCode::SERVICE_UNAVAILABLE, "screening_unavailable")
            }
            ApiError::NotFound => (StatusCode::NOT_FOUND, "not_found"),
            ApiError::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
            ApiError::HostedOff => (StatusCode::NOT_FOUND, "hosted_off"),
            ApiError::Internal(_) => (StatusCode::INTERNAL_SERVER_ERROR, "internal"),
        };
        match &self {
            ApiError::Upstream(d) | ApiError::ScreeningUnavailable(d) | ApiError::Internal(d) => {
                tracing::error!(code, detail = %d, "request failed")
            }
            _ => {}
        }
        (
            status,
            Json(ErrorBody {
                error: code,
                message: self.to_string(),
            }),
        )
            .into_response()
    }
}
