import { updateRemotePlayerPosition, updateAIPositionFromBroadcast } from "./game.js";

let supabase;
let localUid;
let roomId;
let peerConnections = {};
let dataChannels = {};
let realtimeChannel;

const configuration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
    ]
};

export function initWebRTC(supabaseClient, uid, currentRoomId, players) {
    supabase = supabaseClient;
    localUid = uid;
    roomId = currentRoomId;

    const otherPlayers = players.filter(p => p.uid !== localUid);
    otherPlayers.forEach(player => {
        createPeerConnection(player.uid, localUid < player.uid);
    });
    listenForWebRTCSignals();
}

async function createPeerConnection(remoteUid, isOffering) {
    peerConnections[remoteUid] = new RTCPeerConnection(configuration);

    peerConnections[remoteUid].onicecandidate = event => {
        if (event.candidate) {
            supabase.from('signals').insert({
                room_id: roomId,
                from_uid: localUid,
                to_uid: remoteUid,
                data: { candidate: event.candidate.toJSON() }
            }).then();
        }
    };

    if (isOffering) {
        dataChannels[remoteUid] = peerConnections[remoteUid].createDataChannel("gameData");
        setupDataChannel(remoteUid);

        const offer = await peerConnections[remoteUid].createOffer();
        await peerConnections[remoteUid].setLocalDescription(offer);

        await supabase.from('signals').insert({
            room_id: roomId,
            from_uid: localUid,
            to_uid: remoteUid,
            data: { sdp: peerConnections[remoteUid].localDescription.toJSON() }
        });
    } else {
        peerConnections[remoteUid].ondatachannel = event => {
            dataChannels[remoteUid] = event.channel;
            setupDataChannel(remoteUid);
        };
    }
}

function listenForWebRTCSignals() {
    realtimeChannel = supabase.channel(`webrtc-signals-${roomId}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'signals', filter: `to_uid=eq.${localUid}` }, async payload => {
            const signal = payload.new.data;
            const remoteUid = payload.new.from_uid;
            const pc = peerConnections[remoteUid];
            if (!pc) return;

            if (signal.sdp) {
                await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
                if (signal.sdp.type === 'offer') {
                    const answer = await pc.createAnswer();
                    await pc.setLocalDescription(answer);
                    await supabase.from('signals').insert({
                        room_id: roomId,
                        from_uid: localUid,
                        to_uid: remoteUid,
                        data: { sdp: pc.localDescription.toJSON() }
                    });
                }
            } else if (signal.candidate) {
                try {
                    await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
                } catch (e) {
                    console.error('Error adding received ice candidate', e);
                }
            }
        })
        .subscribe();
}

function setupDataChannel(remoteUid) {
    const dc = dataChannels[remoteUid];
    dc.onopen = () => console.log(`Data channel con ${remoteUid} abierto!`);
    dc.onclose = () => console.log(`Data channel con ${remoteUid} cerrado.`);
    dc.onmessage = event => {
        const message = JSON.parse(event.data);
        
        if (message.type === 'position') {
            updateRemotePlayerPosition(remoteUid, message.data);
        }
        if (message.type === 'noise') {
            if (window.handleNoiseEvent) {
                window.handleNoiseEvent(message.data);
            }
        }
        if (message.type === 'ai-position') {
            updateAIPositionFromBroadcast(message.data);
        }
    };
}

export function broadcastData(data) {
    const message = JSON.stringify(data);
    for (const uid in dataChannels) {
        const dc = dataChannels[uid];
        if (dc && dc.readyState === 'open') {
            dc.send(message);
        }
    }
}

export function closeWebRTC() {
    if (realtimeChannel) realtimeChannel.unsubscribe();
    for (const uid in peerConnections) {
        peerConnections[uid].close();
    }
    peerConnections = {};
    dataChannels = {};
}