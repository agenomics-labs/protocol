"""AgentCore Identity adapter.

The Protocol below is what the agent loop calls. Two implementations live
side by side:
  * `InMemoryAgentCoreIdentity`  in-process fake used by unit tests.
  * `BedrockAgentCoreIdentity`   real boto3-backed impl in
    `agentcore.identity_aws`. Selected at runtime by `AGENTCORE_BACKEND=aws`.

Surface 4 uses Identity for two things (master lines 25, 192-194):
  1. OAuth token vault for Nova Act on web2 sites (AC-4, master line 469).
  2. CDP wallet seed storage so Surface 2's `pay_x402_service` can derive
     deterministically from `agent_address` (open question OQ-5).

Surface 4 only *reads* from Identity. It does not store secrets directly.
"""

from __future__ import annotations

from typing import Protocol


class AgentCoreIdentity(Protocol):
    """Protocol the agent loop calls."""

    async def get_oauth_token(
        self,
        *,
        provider: str,
        agent_address: str,
        scopes: list[str] | None = None,
    ) -> str | None:
        """Return a non-expired OAuth access token for `provider`, or None.

        Used by the Nova Act sub-agent (master line 192). AC-4 requires at
        least one OAuth token to be present in the vault for demo (master
        line 469). `scopes` is optional and forwarded verbatim to the
        AgentCore `GetResourceOauth2Token` call.
        """
        ...

    async def get_cdp_wallet_handle(self, *, agent_address: str) -> str:
        """Return an opaque handle Surface 2 uses to load the CDP wallet.

        Per master line 194 + open question OQ-5, the wallet seed lives in
        the Identity vault and is derived deterministically from
        `agent_address`. Surface 4 never sees the seed bytes themselves —
        only this handle, which is passed through to `pay_x402_service`.
        """
        ...


class InMemoryAgentCoreIdentity:
    """Dev/test fake. Holds a single OAuth token + a deterministic wallet
    handle so the AC-4 path is exercisable end-to-end without real AWS."""

    def __init__(
        self,
        oauth_tokens: dict[tuple[str, str], str] | None = None,
    ) -> None:
        # key: (provider, agent_address)
        self._tokens = oauth_tokens or {}

    def upsert_token(self, *, provider: str, agent_address: str, token: str) -> None:
        self._tokens[(provider, agent_address)] = token

    async def get_oauth_token(
        self,
        *,
        provider: str,
        agent_address: str,
        scopes: list[str] | None = None,
    ) -> str | None:
        return self._tokens.get((provider, agent_address))

    async def get_cdp_wallet_handle(self, *, agent_address: str) -> str:
        # Real impl deterministically derives; fake just echoes.
        return f"cdp-wallet:{agent_address}"
