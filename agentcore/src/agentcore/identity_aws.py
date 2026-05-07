"""Real `AgentCoreIdentity` impl backed by Bedrock AgentCore Identity + Secrets Manager.

Wires the abstract Protocol in `agentcore.identity` to two AWS services:

  * **OAuth tokens** -> ``boto3.client("bedrock-agentcore")`` data-plane
    operations:
      1. ``GetWorkloadAccessToken(workloadName)`` returns a short-lived
         workload identity token bound to the agent's AgentCore workload.
      2. ``GetResourceOauth2Token(workloadIdentityToken, scopes,
         resourceCredentialProviderName, oauth2Flow="M2M")`` exchanges that
         workload token for a provider-specific OAuth access token.
  * **CDP wallet handle** -> AWS Secrets Manager:
      ``boto3.client("secretsmanager").get_secret_value(SecretId=
      f"aep/cdp-wallet/{agent_address}")`` -> opaque handle string. Per
      master open question OQ-5 the seed lives in the Identity vault and is
      derived deterministically from `agent_address`. Surface 4 only sees
      this opaque handle and forwards it to `pay_x402_service` (Surface 2).

API verification (boto3 1.43.5, run on this machine):
  * `bedrock-agentcore` exposes `GetWorkloadAccessToken`,
    `GetWorkloadAccessTokenForJWT`, `GetWorkloadAccessTokenForUserId`, and
    `GetResourceOauth2Token`. The high-level
    `bedrock_agentcore.services.identity.IdentityClient` wraps these but
    we go directly via boto3 to avoid the extra dependency at runtime
    (the SDK is still pinned in pyproject for type stubs and the
    workload-identity provisioning helpers used out-of-band).
  * `secretsmanager.get_secret_value` shape is stable since boto3 1.x.

Things still requiring a real AWS call to confirm (documented in the
deliverable, NOT silently assumed):
  * Exact `oauth2Flow` value AgentCore expects for vaulted M2M provider
    creds — boto3 docs list the enum but not which flow per provider type.
    We default to ``"M2M"`` (constant in
    ``bedrock_agentcore.services.identity``).
  * Whether `resourceCredentialProviderName` is the provider's logical
    name (e.g. ``"google-oauth"``) or its full ARN. We pass through the
    `provider` arg verbatim — caller's responsibility.
"""

from __future__ import annotations

import logging
import os
from typing import Any

try:
    import boto3
    from botocore.exceptions import ClientError
except ImportError as exc:  # pragma: no cover — package import-time guard
    raise ImportError(
        "BedrockAgentCoreIdentity requires the optional `aws` extra. Install "
        "with `pip install 'agentcore[aws]'` or add boto3>=1.43.0 manually."
    ) from exc

logger = logging.getLogger(__name__)

# Verified service names on boto3==1.43.5. Both are standard AWS services.
AGENTCORE_SERVICE = "bedrock-agentcore"
SECRETS_SERVICE = "secretsmanager"

# Default OAuth2 flow. M2M is the workload-credential flow used by
# AgentCore's vaulted provider credentials. USER_FEDERATION /
# ON_BEHALF_OF_TOKEN_EXCHANGE are also valid but require user-token plumbing
# that Surface 4 does not yet have.
DEFAULT_OAUTH2_FLOW = "M2M"

# Secret name template for CDP wallet handles. Matches the shape Surface 2
# expects (per master open question OQ-5).
CDP_WALLET_SECRET_TEMPLATE = "aep/cdp-wallet/{agent_address}"


class BedrockAgentCoreIdentity:
    """boto3-backed implementation of `AgentCoreIdentity`.

    Wiring assumptions:
      * `AWS_REGION` env var is set, OR `region_name` is passed in.
      * `AGENTCORE_IDENTITY_WORKLOAD_NAME` env var is set, OR
        `workload_name` is passed in. This is the workload identity name
        provisioned at deploy time via the control-plane SDK.
      * For any provider used in `get_oauth_token`, the corresponding
        OAuth2 credential provider must already exist in AgentCore Identity
        (provisioning is out of band — see README §AWS deployment).
    """

    def __init__(
        self,
        *,
        workload_name: str | None = None,
        region_name: str | None = None,
        agentcore_client: Any | None = None,
        secrets_client: Any | None = None,
    ) -> None:
        self.workload_name = workload_name or os.environ.get(
            "AGENTCORE_IDENTITY_WORKLOAD_NAME", ""
        )
        region = region_name or os.environ.get("AWS_REGION")
        # Allow injection in tests; default constructs from boto3.
        self._agentcore = agentcore_client or boto3.client(
            AGENTCORE_SERVICE, region_name=region
        )
        self._secrets = secrets_client or boto3.client(
            SECRETS_SERVICE, region_name=region
        )

    # -------------------------------------------------------------- OAuth

    async def get_oauth_token(
        self,
        *,
        provider: str,
        agent_address: str,
        scopes: list[str] | None = None,
    ) -> str | None:
        """Return an OAuth access token for `provider`, or None if vault empty.

        Two-step exchange:
          1. `GetWorkloadAccessToken` -> short-lived workload identity token.
          2. `GetResourceOauth2Token` -> provider-specific access token.

        `agent_address` is unused at runtime in the M2M flow (the workload is
        tied to the AgentCore session, not the user). It is accepted for
        Protocol compatibility with the in-memory fake; future user-federated
        flows will route on it.
        """
        if not self.workload_name:
            logger.warning(
                "AGENTCORE_IDENTITY_WORKLOAD_NAME unset; cannot fetch OAuth token"
            )
            return None
        try:
            wat = self._agentcore.get_workload_access_token(
                workloadName=self.workload_name
            )
            workload_token = wat["workloadAccessToken"]
        except ClientError as e:
            logger.error("get_workload_access_token failed: %s", e)
            return None

        try:
            resp = self._agentcore.get_resource_oauth2_token(
                workloadIdentityToken=workload_token,
                resourceCredentialProviderName=provider,
                scopes=list(scopes) if scopes else [],
                oauth2Flow=DEFAULT_OAUTH2_FLOW,
            )
        except ClientError as e:
            logger.error(
                "get_resource_oauth2_token failed for provider %s: %s", provider, e
            )
            return None

        token = resp.get("accessToken")
        if not token:
            # Some flows return an authorizationUrl + sessionUri instead
            # (3LO interactive); for M2M this should not happen.
            logger.warning(
                "no accessToken in get_resource_oauth2_token response; "
                "session_status=%s",
                resp.get("sessionStatus"),
            )
            return None
        return token

    # ----------------------------------------------------------- CDP wallet

    async def get_cdp_wallet_handle(self, *, agent_address: str) -> str:
        """Read the CDP wallet handle from Secrets Manager.

        Per master open question OQ-5: secret name is
        ``aep/cdp-wallet/{agent_address}`` and the value is the opaque
        handle Surface 2's `pay_x402_service` understands. Surface 4 never
        decodes the seed bytes — the handle is a pass-through.
        """
        secret_id = CDP_WALLET_SECRET_TEMPLATE.format(agent_address=agent_address)
        resp = self._secrets.get_secret_value(SecretId=secret_id)
        # Secrets Manager returns either `SecretString` or `SecretBinary`.
        if "SecretString" in resp:
            return resp["SecretString"]
        if "SecretBinary" in resp:
            data = resp["SecretBinary"]
            if isinstance(data, (bytes, bytearray)):
                return data.decode("utf-8")
            return str(data)
        raise RuntimeError(f"Secret {secret_id!r} returned no value")
