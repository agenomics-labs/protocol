"""Unit tests for `agentcore.identity_aws.BedrockAgentCoreIdentity`.

These tests do NOT call AWS. Both boto3 clients (bedrock-agentcore and
secretsmanager) are replaced with `MagicMock`s; tests assert on the
boto3 method names + kwargs.

There is one live integration test at the bottom marked
``@pytest.mark.skip`` + ``@pytest.mark.live_aws``.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from agentcore.identity_aws import (
    CDP_WALLET_SECRET_TEMPLATE,
    DEFAULT_OAUTH2_FLOW,
    BedrockAgentCoreIdentity,
)


@pytest.fixture
def fake_agentcore() -> MagicMock:
    return MagicMock()


@pytest.fixture
def fake_secrets() -> MagicMock:
    return MagicMock()


@pytest.fixture
def ident(
    fake_agentcore: MagicMock, fake_secrets: MagicMock
) -> BedrockAgentCoreIdentity:
    return BedrockAgentCoreIdentity(
        workload_name="aep-reflex-agent",
        region_name="us-east-1",
        agentcore_client=fake_agentcore,
        secrets_client=fake_secrets,
    )


# ------------------------------------------------------------- OAuth


@pytest.mark.asyncio
async def test_get_oauth_token_two_step_exchange(
    ident: BedrockAgentCoreIdentity,
    fake_agentcore: MagicMock,
) -> None:
    fake_agentcore.get_workload_access_token.return_value = {
        "workloadAccessToken": "wat-XYZ"
    }
    fake_agentcore.get_resource_oauth2_token.return_value = {
        "accessToken": "oauth-token-final",
        "sessionStatus": "ACTIVE",
    }

    token = await ident.get_oauth_token(
        provider="google-oauth",
        agent_address="AgentAddr1111",
        scopes=["https://www.googleapis.com/auth/userinfo.email"],
    )

    assert token == "oauth-token-final"

    # Step 1 — workload access token.
    fake_agentcore.get_workload_access_token.assert_called_once_with(
        workloadName="aep-reflex-agent"
    )

    # Step 2 — resource OAuth2 token; check kwargs verbatim.
    fake_agentcore.get_resource_oauth2_token.assert_called_once_with(
        workloadIdentityToken="wat-XYZ",
        resourceCredentialProviderName="google-oauth",
        scopes=["https://www.googleapis.com/auth/userinfo.email"],
        oauth2Flow=DEFAULT_OAUTH2_FLOW,
    )


@pytest.mark.asyncio
async def test_get_oauth_token_returns_none_when_workload_unset(
    fake_agentcore: MagicMock, fake_secrets: MagicMock
) -> None:
    ident = BedrockAgentCoreIdentity(
        workload_name="",  # explicitly empty
        region_name="us-east-1",
        agentcore_client=fake_agentcore,
        secrets_client=fake_secrets,
    )
    token = await ident.get_oauth_token(
        provider="google-oauth", agent_address="AgentAddr1111"
    )
    assert token is None
    fake_agentcore.get_workload_access_token.assert_not_called()


@pytest.mark.asyncio
async def test_get_oauth_token_handles_missing_access_token(
    ident: BedrockAgentCoreIdentity, fake_agentcore: MagicMock
) -> None:
    fake_agentcore.get_workload_access_token.return_value = {
        "workloadAccessToken": "wat-XYZ"
    }
    # 3LO interactive flow returns authorizationUrl + sessionUri instead of
    # accessToken; M2M should not see this, but the impl must not crash.
    fake_agentcore.get_resource_oauth2_token.return_value = {
        "authorizationUrl": "https://idp.example/authorize?...",
        "sessionUri": "session://abc",
        "sessionStatus": "PENDING_USER",
    }
    token = await ident.get_oauth_token(
        provider="some-3lo-provider", agent_address="AgentAddr1111"
    )
    assert token is None


# ----------------------------------------------------- CDP wallet handle


@pytest.mark.asyncio
async def test_get_cdp_wallet_handle_reads_secrets_manager_string(
    ident: BedrockAgentCoreIdentity, fake_secrets: MagicMock
) -> None:
    fake_secrets.get_secret_value.return_value = {
        "SecretString": "cdp-handle-deadbeef"
    }
    handle = await ident.get_cdp_wallet_handle(agent_address="AgentAddrXYZ")
    assert handle == "cdp-handle-deadbeef"
    fake_secrets.get_secret_value.assert_called_once_with(
        SecretId=CDP_WALLET_SECRET_TEMPLATE.format(agent_address="AgentAddrXYZ")
    )


@pytest.mark.asyncio
async def test_get_cdp_wallet_handle_decodes_secret_binary(
    ident: BedrockAgentCoreIdentity, fake_secrets: MagicMock
) -> None:
    fake_secrets.get_secret_value.return_value = {
        "SecretBinary": b"binary-handle"
    }
    handle = await ident.get_cdp_wallet_handle(agent_address="AgentAddrXYZ")
    assert handle == "binary-handle"


@pytest.mark.asyncio
async def test_get_cdp_wallet_handle_raises_when_secret_empty(
    ident: BedrockAgentCoreIdentity, fake_secrets: MagicMock
) -> None:
    fake_secrets.get_secret_value.return_value = {}  # no String/Binary
    with pytest.raises(RuntimeError, match="returned no value"):
        await ident.get_cdp_wallet_handle(agent_address="AgentAddrXYZ")


# -------------------------------------------------------------- live


@pytest.mark.skip(
    reason=(
        "live_aws: requires AWS_REGION + AGENTCORE_IDENTITY_WORKLOAD_NAME +"
        " a provisioned OAuth2 credential provider in AgentCore Identity, +"
        " a Secrets Manager secret named per CDP_WALLET_SECRET_TEMPLATE. To"
        " enable, export AWS_REGION, AGENTCORE_IDENTITY_WORKLOAD_NAME,"
        " AGENTCORE_BACKEND=aws, ensure the secret exists, then run"
        " `pytest -m live_aws tests/test_identity_aws.py::test_live_round_trip`."
    )
)
@pytest.mark.live_aws
@pytest.mark.asyncio
async def test_live_round_trip() -> None:
    """Real AWS smoke: fetch one OAuth token + one CDP wallet handle.

    Env vars required:
      AWS_REGION                              e.g. us-east-1
      AGENTCORE_IDENTITY_WORKLOAD_NAME        provisioned workload identity
      AEP_TEST_PROVIDER                       OAuth2 provider name in vault
      AEP_TEST_AGENT_ADDRESS                  matches an existing
                                              `aep/cdp-wallet/<addr>` secret
    """
    raise NotImplementedError(
        "Day 3+: enable when AgentCore Identity workload provisioned."
    )
