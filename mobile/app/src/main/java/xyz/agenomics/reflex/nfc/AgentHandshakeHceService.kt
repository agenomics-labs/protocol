package xyz.agenomics.reflex.nfc

import android.nfc.cardemulation.HostApduService
import android.os.Bundle

/**
 * Skeleton NFC Host Card Emulation service for the two-phone agent
 * handshake described in Surface 1 of the Reflex spec. The real APDU
 * exchange (`SELECT` / `READ_AGENT_CARD` / `PROPOSE_ESCROW` /
 * `ACCEPT_OR_REJECT`) lands in a later iteration once the AID and TLV
 * encodings are locked.
 *
 * For Day 1 we only register the service so the manifest validates and
 * the manifest-declared AID is reachable when paired with a Seeker.
 */
class AgentHandshakeHceService : HostApduService() {

    override fun processCommandApdu(commandApdu: ByteArray?, extras: Bundle?): ByteArray {
        // 0x6A82 — "File or application not found". Polite "I'm here but
        // I don't know how to talk yet" until the protocol is implemented.
        return byteArrayOf(0x6A.toByte(), 0x82.toByte())
    }

    override fun onDeactivated(reason: Int) {
        // No-op until we keep handshake state across APDUs.
    }
}
