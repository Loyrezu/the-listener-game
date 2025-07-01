import { supabase } from './supabase-client.js';
import { initGame, startGameLoop, updateAIState } from './game.js';
import { initWebRTC, closeWebRTC } from './webrtc.js';

// --- Envolvemos todo en un listener para asegurar que el HTML esté cargado ---
document.addEventListener('DOMContentLoaded', () => {
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
    let roomSubscription = null;
    let isHost = false;

    function showScreen(screenToShow) {
        screens.forEach(screen => screen.classList.add('hidden'));
        screenToShow.classList.remove('hidden');
    }

    async function handleAuth() {
        const { data, error } = await supabase.auth.signInAnonymously();
        if (error) {
            console.error("Error en la autenticación anónima:", error);
            return;
        }
        currentUser = data.user;
        showScreen(lobbyScreen);
        listenForRooms();
    }

    function listenForRooms() {
        supabase
            .channel('public:rooms')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms' }, payload => {
                fetchRooms();
            })
            .subscribe();
        fetchRooms();
    }

    async function fetchRooms() {
        const { data: rooms, error } = await supabase.from('rooms').select('*').eq('status', 'waiting');
        if (error) {
            console.error("Error al obtener salas:", error);
            return;
        }
        roomsList.innerHTML = '';
        rooms.forEach(room => {
            const roomItem = document.createElement('div');
            roomItem.className = 'room-item';
            roomItem.innerHTML = `
                <span>${room.name} (${(room.players || []).length}/5)</span>
                <button data-room-id="${room.id}">Unirse</button>
            `;
            roomsList.appendChild(roomItem);
        });
    }

    createRoomBtn.addEventListener('click', async () => {
        const roomName = roomNameInput.value.trim();
        if (!roomName) return alert("Por favor, introduce un nombre para la sala.");

        const roomSize = 20;
        const keyPosition = { x: Math.random() * (roomSize - 2) - (roomSize / 2 - 1), y: 1, z: Math.random() * (roomSize - 2) - (roomSize / 2 - 1) };
        const aiPosition = { x: 0, y: 1.25, z: 0 };

        const { data, error } = await supabase.from('rooms').insert({
            name: roomName,
            host_id: currentUser.id,
            players: [],
            key_position: keyPosition,
            ai_position: aiPosition,
            caught_players: []
        }).select().single();

        if (error) {
            console.error("Error al crear la sala:", error);
            return;
        }
        joinRoom(data.id);
    });

    roomsList.addEventListener('click', (e) => {
        if (e.target.tagName === 'BUTTON') {
            const roomId = e.target.getAttribute('data-room-id');
            joinRoom(roomId);
        }
    });

    async function joinRoom(roomId) {
        const { data: room, error: fetchError } = await supabase.from('rooms').select('players').eq('id', roomId).single();
        if (fetchError || !room) {
            alert("La sala no existe o está llena.");
            return;
        }

        const players = room.players || [];
        if (players.length >= 5) {
            alert("La sala está llena.");
            return;
        }

        const newPlayers = [...players, { uid: currentUser.id, name: `Player-${currentUser.id.substring(0, 5)}` }];
        const { error: updateError } = await supabase.from('rooms').update({ players: newPlayers }).eq('id', roomId);

        if (updateError) {
            console.error("Error al unirse a la sala:", updateError);
            return;
        }

        currentRoomId = roomId;
        listenToCurrentRoom(roomId);
        showScreen(roomWaitScreen);
    }

    function listenToCurrentRoom(roomId) {
        if (roomSubscription) roomSubscription.unsubscribe();
        
        roomSubscription = supabase.channel(`public:rooms:id=eq.${roomId}`)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms', filter: `id=eq.${roomId}` }, payload => {
                handleRoomUpdate(payload.new);
            })
            .subscribe();

        supabase.from('rooms').select('*').eq('id', roomId).single().then(({ data }) => handleRoomUpdate(data));
    }

    function handleRoomUpdate(room) {
        if (!room || room.status === 'finished') {
            alert("La partida ha terminado. Volviendo al lobby.");
            leaveRoom();
            return;
        }

        const caughtPlayers = room.caught_players || [];
        const isCaught = caughtPlayers.includes(currentUser.id);
        isHost = room.host_id === currentUser.id;

        if (isCaught && !spectateUI.classList.contains('active')) {
            spectateUI.classList.remove('hidden');
            spectateUI.classList.add('active');
            if (window.enterSpectateMode) window.enterSpectateMode();
        }

        roomTitle.textContent = `Sala: ${room.name}`;
        playersList.innerHTML = '';
        (room.players || []).filter(p => !caughtPlayers.includes(p.uid)).forEach(player => {
            const li = document.createElement('li');
            li.textContent = `${player.name} ${player.uid === room.host_id ? '(Anfitrión)' : ''}`;
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
            window.currentRoomId = room.id;
            initWebRTC(supabase, currentUser.id, room.id, room.players);
            initGame(room.players, currentUser.id, room); 
            startGameLoop(room.id, isHost);
        }

        if (room.key_found) {
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

        if (isHost && room.status === 'in-game' && room.ai_state === 'dormant') {
            const livingPlayers = (room.players || []).filter(p => !caughtPlayers.includes(p.uid));
            
            if (room.key_found && room.key_holder_uid) {
                supabase.from('rooms').update({ ai_state: "hunting", ai_target_uid: room.key_holder_uid, threat_level: 0 }).eq('id', currentRoomId).then();
            } else if (!room.key_found && room.threat_level >= 5) {
                if (livingPlayers.map(p => p.uid).includes(room.last_noise_maker)) {
                    supabase.from('rooms').update({ ai_state: "hunting", ai_target_uid: room.last_noise_maker }).eq('id', currentRoomId).then();
                }
            }
        }
        
        if (room.status === 'in-game') {
            updateAIState({ state: room.ai_state, position: room.ai_position, targetUid: room.ai_target_uid });
            if (window.updateCaughtPlayers) window.updateCaughtPlayers(caughtPlayers);
        }
    }

    startGameBtn.addEventListener('click', async () => {
        await supabase.from('rooms').update({ status: 'in-game' }).eq('id', currentRoomId);
    });

    leaveMatchBtn.addEventListener('click', () => {
        leaveRoom();
    });

    spectateNextBtn.addEventListener('click', () => {
        if (window.cycleSpectateTarget) {
            window.cycleSpectateTarget();
        }
    });

    window.handleNoiseEvent = async (noiseData) => {
        if (isHost) {
            const { data, error } = await supabase.from('rooms').select('threat_level').eq('id', currentRoomId).single();
            if (data) {
                await supabase.from('rooms').update({ threat_level: data.threat_level + 1, last_noise_maker: noiseData.from }).eq('id', currentRoomId);
            }
        }
    };

    async function leaveRoom() {
        if (!currentRoomId) return;
        
        const wasSpectating = spectateUI.classList.contains('active');
        if (window.cleanupGame) window.cleanupGame();
        
        if (!wasSpectating) {
            const { data: room } = await supabase.from('rooms').select('players').eq('id', currentRoomId).single();
            const updatedPlayers = (room.players || []).filter(p => p.uid !== currentUser.id);
            await supabase.from('rooms').update({ players: updatedPlayers }).eq('id', currentRoomId);
        }

        if(roomSubscription) roomSubscription.unsubscribe();
        currentRoomId = null;
        isHost = false;
        closeWebRTC();
        showScreen(lobbyScreen);
        
        const keyMessage = document.getElementById('key-found-message');
        if (keyMessage) keyMessage.remove();
        spectateUI.classList.add('hidden');
        spectateUI.classList.remove('active');
    }

    // Iniciar la aplicación
    handleAuth();
});