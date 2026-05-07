package xyz.agenomics.reflex.ui

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import kotlinx.coroutines.launch
import xyz.agenomics.reflex.R
import xyz.agenomics.reflex.data.WalletClient

object DiscoverTestTags {
    const val PROMPT_FIELD = "discover-prompt"
    const val SUBMIT = "discover-submit"
    const val CONNECT_WALLET = "discover-connect-wallet"
}

/**
 * "Task Input" surface from the Surface 1 spec. Submitting opens an
 * AgentCore session via [DiscoverViewModel] and bubbles the new
 * sessionId up through [onSessionStarted] — the live narration is
 * rendered by [xyz.agenomics.reflex.ui.session.LiveSessionScreen].
 */
@Composable
fun DiscoverScreen(
    onSessionStarted: (String) -> Unit = {},
    viewModel: DiscoverViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val activity = context as? ComponentActivity

    val resultSender = remember(activity) {
        activity?.let { ActivityResultSender(it) }
    }
    val scope = androidx.compose.runtime.rememberCoroutineScope()

    val walletClient = remember { activity?.let { WalletClient(it) } }

    // Bridge SharedFlow → callback so navigation lives in the screen.
    LaunchedEffect(viewModel) {
        viewModel.navigationEvents.collect { event ->
            when (event) {
                is DiscoverViewModel.DiscoverNavEvent.OpenLiveSession ->
                    onSessionStarted(event.sessionId)
            }
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(
            text = stringResource(R.string.discover_title),
            style = MaterialTheme.typography.headlineSmall,
        )

        OutlinedTextField(
            value = state.prompt,
            onValueChange = viewModel::onPromptChange,
            modifier = Modifier
                .fillMaxWidth()
                .testTag(DiscoverTestTags.PROMPT_FIELD),
            minLines = 3,
            label = { Text(stringResource(R.string.discover_prompt_hint)) },
            enabled = !state.isOpening,
        )

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Button(
                onClick = { viewModel.submit() },
                enabled = state.prompt.isNotBlank() && !state.isOpening,
                modifier = Modifier.testTag(DiscoverTestTags.SUBMIT),
            ) {
                Text(stringResource(R.string.discover_submit))
            }
            OutlinedButton(
                onClick = {
                    val act = activity ?: return@OutlinedButton
                    val sender = resultSender ?: return@OutlinedButton
                    val client = walletClient ?: return@OutlinedButton
                    scope.launch {
                        val pubkey = client.authorize(act, sender)
                        viewModel.onWalletConnected(pubkey)
                    }
                },
                enabled = !state.isOpening,
                modifier = Modifier.testTag(DiscoverTestTags.CONNECT_WALLET),
            ) {
                Text(
                    text = state.walletPubkey?.let {
                        stringResource(R.string.discover_wallet_connected, it.take(8) + "…")
                    } ?: stringResource(R.string.discover_connect_wallet),
                )
            }
            if (state.isOpening) {
                CircularProgressIndicator(strokeWidth = 2.dp)
            }
        }

        state.errorMessage?.let { msg ->
            Text(
                text = msg,
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}
