import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-auth.js";
import { getFirestore, doc, setDoc, getDoc, collection, onSnapshot, updateDoc, arrayUnion, arrayRemove, runTransaction, increment } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-firestore.js";
import { initGame, startGameLoop, updateAIState } from './game.js';
import { initWebRTC, closeWebRTC } from './webrtc.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const loadingScreen = document.getElementById('loading-screen');
const lobbyScreen = document.getElementById('lobby-screen');
const roomWaitScreen = document.getElementById('room-wait-screen');
const gameContainer = document.getElementById('game-container');
const spectateUI = document.getElementById('spectate-ui');
const screens = [loadingScreen, lobbyScreen, roomWaitScreen, gameContainer];

const createRoomBtn = document.getElementById('create-room-btn');
const roomNameInput = document.getElementById('room-name-input');
const roomsList = document.getElementById('rooms-list');
const roomTitle = document.getElementById('room-title');
const playersList = document.getElementById('players-list');
const startGameBtn = document.getElementById('start-game-btn');
const startGameContainer = document.getElementById('start-game-container');
const startGameWaitingText = document.getElementById('start-game-waiting-text');
const leaveMatchBtn = document.getElementById('leave-match-btn');
const spectateNextBtn = document.getElementById('spectate-next-btn');

let currentUser = null;
let currentRoomId = null;
let roomUnsubscribe = null;
let isHost = false;

function showScreen(screenToShow) {
    screens.forEach(screen => screen.classList.add('hidden'));
    screenToShow.classList.remove('hidden');
}

onAuthStateChanged(auth, (user) => {
    if (user) {
        currentUser = user;
        showScreen(lobbyScreen);
        listenForRooms();
    } else {
        signInAnonymously(auth).catch(error => console.error("Error en la autenticación anónima:", error));
    }
});

function listenForRooms() {
    const roomsRef = collection(db, "rooms");
    onSnapshot(roomsRef, (snapshot) => {
        roomsList.innerHTML = '';
        snapshot.forEach(doc => {
            const room = doc.data();
            if (room.status === 'waiting') {
                const roomItem = document.createElement('div');
                roomItem.className = 'room-item';
                roomItem.innerHTML = `
                    <span>${room.name} (${(room.players || []).length}/5)</span>
                    <button data-room-id="${doc.id}">Unirse</button>
                `;
                roomsList.appendChild(roomItem);
            }
        });
    });
}

createRoomBtn.addEventListener('click', async () => {
    const roomName = roomNameInput.value.trim();
    if (!roomName) return alert("Por favor, introduce un nombre para la sala.");

    const newRoomRef = doc(collection(db, "rooms"));
    
    const roomSize = 20;
    const keyPosition = {
        x: Math.random() * (roomSize - 2) - (roomSize / 2 - 1),
        y: 1,
        z: Math.random() * (roomSize - 2) - (roomSize / 2 - 1)
    };

    const roomData = {
        name: roomName,
        hostId: currentUser.uid,
        players: [],
        status: 'waiting',
        createdAt: new Date(),
        keyPosition: keyPosition,
        keyFound: false,
        keyHolderUid: null,
        threatLevel: 0,
        lastNoiseMaker: null,
        caughtPlayers: [],
        ai: {
            state: 'dormant',
            position: { x: 0, y: 1.25, z: 0 },
            targetUid: null
        }
    };
    await setDoc(newRoomRef, roomData);
    joinRoom(newRoomRef.id);
});

roomsList.addEventListener('click', (e) => {
    if (e.target.tagName === 'BUTTON') {
        const roomId = e.target.getAttribute('data-room-id');
        joinRoom(roomId);
    }
});

async function joinRoom(roomId) {
    const roomRef = doc(db, "rooms", roomId);
    try {
        await runTransaction(db, async (transaction) => {
            const roomDoc = await transaction.get(roomRef);
            if (!roomDoc.exists()) throw "La sala no existe.";
            const room = roomDoc.data();
            if ((room.players || []).length >= 5) throw "La sala está llena.";
            
            transaction.update(roomRef, { 
                players: arrayUnion({ uid: currentUser.uid, name: `Player-${currentUser.uid.substring(0, 5)}` })
            });
        });
        currentRoomId = roomId;
        listenToCurrentRoom(roomId);
        showScreen(roomWaitScreen);
    } catch (error) {
        console.error("Error al unirse a la sala:", error);
        alert(error);
    }
}

function listenToCurrentRoom(roomId) {
    if (roomUnsubscribe) roomUnsubscribe();
    
    const roomRef = doc(db, "rooms", roomId);
    roomUnsubscribe = onSnapshot(roomRef, (docSnap) => {
        if (!docSnap.exists() || docSnap.data().status === 'finished') {
            alert("La partida ha terminado. Volviendo al lobby.");
            leaveRoom();
            return;
        }

        const room = docSnap.data();
        const caughtPlayers = room.caughtPlayers || [];
        const isCaught = caughtPlayers.includes(currentUser.uid);
        isHost = room.hostId === currentUser.uid;

        if (isCaught && !spectateUI.classList.contains('active')) {
            spectateUI.classList.remove('hidden');
            spectateUI.classList.add('active');
            if (window.enterSpectateMode) window.enterSpectateMode();
        }

        roomTitle.textContent = `Sala: ${room.name}`;
        playersList.innerHTML = '';
        (room.players || []).filter(p => !caughtPlayers.includes(p.uid)).forEach(player => {
            const li = document.createElement('li');
            li.textContent = `${player.name} ${player.uid === room.hostId ? '(Anfitrión)' : ''}`;
            playersList.appendChild(li);
        });

        if (isHost) {
            startGameBtn.classList.remove('hidden');
            startGameWaitingText.classList.add('hidden');
        } else {
            startGameBtn.classList.add('hidden');
            startGameWaitingText.classList.remove('hidden');
        }

        if (room.status === 'in-game' && gameContainer.classList.contains('hidden')) {
            showScreen(gameContainer);
            window.currentRoomId = roomId;
            initWebRTC(db, currentUser.uid, roomId, room.players);
            initGame(room.players, currentUser.uid, room); 
            startGameLoop(roomId, isHost);
        }

        if (room.keyFound) {
            const keyMessage = document.getElementById('key-found-message');
            if (!keyMessage) {
                const messageDiv = document.createElement('div');
                messageDiv.id = 'key-found-message';
                messageDiv.textContent = '¡LA LLAVE HA SIDO ENCONTRADA!';
                messageDiv.style.position = 'absolute';
                messageDiv.style.top = '20px';
                messageDiv.style.left = '50%';
                messageDiv.style.transform = 'translateX(-50%)';
                messageDiv.style.color = 'gold';
                messageDiv.style.fontSize = '24px';
                messageDiv.style.textShadow = '2px 2px 4px black';
                document.body.appendChild(messageDiv);
            }
            if (window.removeKeyFromScene) window.removeKeyFromScene();
        }

        if (isHost && room.status === 'in-game' && room.ai.state === 'dormant') {
            const livingPlayers = (room.players || []).filter(p => !caughtPlayers.includes(p.uid));
            
            if (room.keyFound && room.keyHolderUid) {
                updateDoc(roomRef, { "ai.state": "hunting", "ai.targetUid": room.keyHolderUid, threatLevel: 0 });
            } else if (!room.keyFound && room.threatLevel >= 5) {
                if (livingPlayers.map(p => p.uid).includes(room.lastNoiseMaker)) {
                    updateDoc(roomRef, { "ai.state": "hunting", "ai.targetUid": room.lastNoiseMaker });
                }
            }
        }
        
        if (room.status === 'in-game') {
            updateAIState(room.ai);
            if (window.updateCaughtPlayers) window.updateCaughtPlayers(caughtPlayers);
        }
    });
}

startGameBtn.addEventListener('click', async () => {
    const roomRef = doc(db, "rooms", currentRoomId);
    await updateDoc(roomRef, { status: 'in-game' });
});

leaveMatchBtn.addEventListener('click', () => {
    leaveRoom();
});

spectateNextBtn.addEventListener('click', () => {
    if (window.cycleSpectateTarget) {
        window.cycleSpectateTarget();
    }
});

window.handleNoiseEvent = (noiseData) => {
    if (isHost) {
        const roomRef = doc(db, "rooms", currentRoomId);
        updateDoc(roomRef, {
            threatLevel: increment(1),
            lastNoiseMaker: noiseData.from
        });
    }
};

async function leaveRoom() {
    if (!currentRoomId) return;
    
    const wasSpectating = spectateUI.classList.contains('active');
    if (window.cleanupGame) window.cleanupGame();
    
    const roomRef = doc(db, "rooms", currentRoomId);
    if (!wasSpectating) {
        await updateDoc(roomRef, {
            players: arrayRemove({ uid: currentUser.uid, name: `Player-${currentUser.uid.substring(0, 5)}` })
        });
    }

    if(roomUnsubscribe) roomUnsubscribe();
    currentRoomId = null;
    isHost = false;
    closeWebRTC();
    showScreen(lobbyScreen);
    
    const keyMessage = document.getElementById('key-found-message');
    if (keyMessage) keyMessage.remove();
    spectateUI.classList.add('hidden');
    spectateUI.classList.remove('active');
}