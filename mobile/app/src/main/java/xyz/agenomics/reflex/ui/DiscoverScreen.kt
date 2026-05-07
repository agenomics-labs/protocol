package xyz.agenomics.reflex.ui

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Button
import androidx.compose.material3.Card
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import kotlinx.coroutines.launch
import xyz.agenomics.reflex.R
import xyz.agenomics.reflex.data.WalletClient

@Composable
fun DiscoverScreen(
    viewModel: DiscoverViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val activity = context as? ComponentActivity

    // ActivityResultSender must be remembered against the host Activity so
    // MWA's wallet sheet can deliver its result back to us.
    val resultSender = remember(activity) {
        activity?.let { ActivityResultSender(it) }
    }
    val scope = rememberCoroutineScopeBridge()

    val walletClient = remember { activity?.let { WalletClient(it) } }

    val listState = rememberLazyListState()
    LaunchedEffect(state.log.size) {
        if (state.log.isNotEmpty()) {
            listState.animateScrollToItem(state.log.lastIndex)
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
            modifier = Modifier.fillMaxWidth(),
            minLines = 3,
            label = { Text(stringResource(R.string.discover_prompt_hint)) },
            enabled = !state.isStreaming,
        )

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Button(
                onClick = { viewModel.submit() },
                enabled = state.prompt.isNotBlank() && !state.isStreaming,
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
                enabled = !state.isStreaming,
            ) {
                Text(
                    text = state.walletPubkey?.let {
                        stringResource(R.string.discover_wallet_connected, it.take(8) + "…")
                    } ?: stringResource(R.string.discover_connect_wallet),
                )
            }
            if (state.isStreaming) {
                Spacer(Modifier.height(8.dp))
                CircularProgressIndicator()
            }
        }

        Card(modifier = Modifier.fillMaxSize()) {
            if (state.log.isEmpty()) {
                Text(
                    text = stringResource(R.string.discover_log_empty),
                    modifier = Modifier.padding(16.dp),
                    style = MaterialTheme.typography.bodyMedium,
                )
            } else {
                LazyColumn(
                    state = listState,
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(8.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    items(state.log) { entry ->
                        Column(modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp)) {
                            Text(
                                text = entry.kind.uppercase(),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.primary,
                            )
                            Text(
                                text = entry.text,
                                style = MaterialTheme.typography.bodySmall,
                                fontFamily = FontFamily.Monospace,
                            )
                        }
                    }
                }
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

/**
 * Tiny shim around [androidx.compose.runtime.rememberCoroutineScope] so the
 * wallet-connect button can fire-and-forget MWA calls without leaking
 * the launch site into [DiscoverViewModel].
 */
@Composable
private fun rememberCoroutineScopeBridge(): kotlinx.coroutines.CoroutineScope =
    androidx.compose.runtime.rememberCoroutineScope()
