import { doc, collection, addDoc, onSnapshot, updateDoc, getDoc } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-firestore.js";
import { updateRemotePlayerPosition, updateAIPositionFromBroadcast } from "./game.js";

let db;
let localUid;
let roomId;
let peerConnections = {};
let dataChannels = {};

const configuration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
    ]
};

export function initWebRTC(firestoreDb, uid, currentRoomId, players) {
    db = firestoreDb;
    localUid = uid;
    roomId = currentRoomId;

    const otherPlayers = players.filter(p => p.uid !== localUid);
    otherPlayers.forEach(player => {
        if (localUid < player.uid) {
            createPeerConnection(player.uid, true);
        } else {
            createPeerConnection(player.uid, false);
        }
    });
    listenForWebRTCSignals();
}

function createPeerConnection(remoteUid, isOffering) {
    peerConnections[remoteUid] = new RTCPeerConnection(configuration);

    peerConnections[remoteUid].onicecandidate = event => {
        if (event.candidate) {
            const signalRef = collection(db, "rooms", roomId, "signals");
            addDoc(signalRef, {
                from: localUid,
                to: remoteUid,
                candidate: event.candidate.toJSON()
            });
        }
    };

    if (isOffering) {
        dataChannels[remoteUid] = peerConnections[remoteUid].createDataChannel("gameData");
        setupDataChannel(remoteUid);

        peerConnections[remoteUid].createOffer()
            .then(offer => peerConnections[remoteUid].setLocalDescription(offer))
            .then(() => {
                const offerPayload = {
                    from: localUid,
                    to: remoteUid,
                    sdp: peerConnections[remoteUid].localDescription.toJSON()
                };
                const signalRef = collection(db, "rooms", roomId, "signals");
                addDoc(signalRef, offerPayload);
            });
    } else {
        peerConnections[remoteUid].ondatachannel = event => {
            dataChannels[remoteUid] = event.channel;
            setupDataChannel(remoteUid);
        };
    }
}

function listenForWebRTCSignals() {
    const signalsRef = collection(db, "rooms", roomId, "signals");
    onSnapshot(signalsRef, snapshot => {
        snapshot.docChanges().forEach(change => {
            if (change.type === 'added') {
                const signal = change.doc.data();
                const remoteUid = signal.from;

                if (signal.to !== localUid) return;

                const pc = peerConnections[remoteUid];
                if (!pc) return;

                if (signal.sdp) {
                    pc.setRemoteDescription(new RTCSessionDescription(signal.sdp))
                        .then(() => {
                            if (signal.sdp.type === 'offer') {
                                pc.createAnswer()
                                    .then(answer => pc.setLocalDescription(answer))
                                    .then(() => {
                                        const answerPayload = {
                                            from: localUid,
                                            to: remoteUid,
                                            sdp: pc.localDescription.toJSON()
                                        };
                                        const signalRef = collection(db, "rooms", roomId, "signals");
                                        addDoc(signalRef, answerPayload);
                                    });
                            }
                        }).catch(e => console.error("Error setting remote description:", e));
                } else if (signal.candidate) {
                    pc.addIceCandidate(new RTCIceCandidate(signal.candidate))
                       .catch(e => console.error("Error adding ICE candidate:", e));
                }
            }
        });
    });
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
    for (const uid in peerConnections) {
        peerConnections[uid].close();
    }
    peerConnections = {};
    dataChannels = {};
}