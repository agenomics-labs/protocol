package xyz.agenomics.reflex.ui.session

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import xyz.agenomics.reflex.R

object LiveSessionTestTags {
    const val ROOT = "live-session-root"
    const val CANCEL = "live-session-cancel"
    const val PANE_REASONING = "live-session-pane-reasoning"
    const val PANE_PAYMENTS = "live-session-pane-payments"
    const val PANE_RESULT = "live-session-pane-result"
    const val SPEND = "live-session-spend"
}

/**
 * In-progress session UI. Stacked panes on phone-portrait: Reasoning →
 * Payments → Result. The "three-pane" layout from the spec stacks
 * vertically here because Seeker is a phone — splitting horizontally on
 * a 6-inch screen produces unreadable columns. A future tablet build
 * can swap in `Row` of equal-weight columns.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LiveSessionScreen(
    sessionId: String,
    onClose: () -> Unit,
    viewModel: LiveSessionViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    // The viewModel snapshots the sessionId from SavedStateHandle; this
    // assertion just guards against composition mismatches in dev.
    LaunchedEffect(sessionId) { check(state.sessionId == sessionId) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(
                            text = stringResource(R.string.live_session_title),
                            style = MaterialTheme.typography.titleMedium,
                        )
                        Text(
                            text = stringResource(
                                R.string.live_session_elapsed_short,
                                formatElapsed(state.elapsedSeconds),
                            ),
                            style = MaterialTheme.typography.labelSmall,
                        )
                    }
                },
                actions = {
                    IconButton(
                        onClick = {
                            viewModel.cancel()
                            onClose()
                        },
                        modifier = Modifier.testTag(LiveSessionTestTags.CANCEL),
                    ) {
                        Icon(
                            imageVector = Icons.Default.Close,
                            contentDescription = stringResource(R.string.live_session_cancel_cd),
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.primary,
                    titleContentColor = MaterialTheme.colorScheme.onPrimary,
                    actionIconContentColor = MaterialTheme.colorScheme.onPrimary,
                ),
            )
        },
        bottomBar = {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(16.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = stringResource(
                        R.string.live_session_running_total,
                        formatUsdc(state.totalSpentUsdcMicros),
                    ),
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.secondary,
                    modifier = Modifier.testTag(LiveSessionTestTags.SPEND),
                )
            }
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(horizontal = 12.dp, vertical = 8.dp)
                .testTag(LiveSessionTestTags.ROOT),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Pane(
                title = stringResource(R.string.live_session_pane_reasoning),
                entries = state.reasoning,
                tag = LiveSessionTestTags.PANE_REASONING,
                emphasised = false,
                modifier = Modifier.weight(1f),
            )
            Pane(
                title = stringResource(R.string.live_session_pane_payments),
                entries = state.payments,
                tag = LiveSessionTestTags.PANE_PAYMENTS,
                emphasised = false,
                modifier = Modifier.weight(1f),
            )
            Pane(
                title = stringResource(R.string.live_session_pane_result),
                entries = state.results,
                tag = LiveSessionTestTags.PANE_RESULT,
                emphasised = true,
                modifier = Modifier.weight(1f),
            )

            state.errorMessage?.let { msg ->
                Text(
                    text = msg,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
    }
}

@Composable
private fun Pane(
    title: String,
    entries: List<LiveSessionUiState.PaneEntry>,
    tag: String,
    emphasised: Boolean,
    modifier: Modifier = Modifier,
) {
    val listState = rememberLazyListState()
    LaunchedEffect(entries.size) {
        if (entries.isNotEmpty()) {
            listState.animateScrollToItem(entries.lastIndex)
        }
    }
    Card(
        modifier = modifier
            .fillMaxWidth()
            .testTag(tag),
        colors = if (emphasised) CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.primaryContainer,
        ) else CardDefaults.cardColors(),
    ) {
        Column(modifier = Modifier.padding(12.dp)) {
            Text(
                text = title,
                style = MaterialTheme.typography.labelSmall,
                color = if (emphasised) MaterialTheme.colorScheme.onPrimary
                else MaterialTheme.colorScheme.primary,
            )
            if (entries.isEmpty()) {
                Text(
                    text = stringResource(R.string.live_session_pane_empty),
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(top = 4.dp),
                )
            } else {
                LazyColumn(
                    state = listState,
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(top = 4.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    items(entries) { entry ->
                        Row(modifier = Modifier.fillMaxWidth()) {
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
    }
}

private fun formatElapsed(seconds: Long): String {
    val m = seconds / 60
    val s = seconds % 60
    return "%d:%02d".format(m, s)
}

/** USDC has 6 decimals (1 USDC = 1_000_000 micros). */
private fun formatUsdc(micros: Long): String =
    "%.4f".format(micros / 1_000_000.0)
