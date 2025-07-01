import { broadcastData } from './webrtc.js';
import { supabase } from './supabase-client.js';

let scene, camera, renderer;
let localPlayer, localPlayerUid;
let remotePlayers = {};
let controls;
let keyObject = null;
let listenerAI = null;
let isSpectating = false;
let spectateTargetIndex = 0;
let spectatorLight = null;
let spectatorCameraMode = 'third-person';

export function initGame(players, myUid, roomData) {
    localPlayerUid = myUid;
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);

    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    scene.add(camera);

    const canvas = document.getElementById('game-canvas');
    renderer = new THREE.WebGLRenderer({ canvas: canvas });
    renderer.setSize(window.innerWidth, window.innerHeight);

    const caughtPlayers = roomData.caught_players || [];
    players.filter(p => !caughtPlayers.includes(p.uid)).forEach(player => {
        const geometry = new THREE.BoxGeometry(1, 2, 1);
        const material = new THREE.MeshStandardMaterial({ color: player.uid === myUid ? 0x00ff00 : 0xff0000 });
        const cube = new THREE.Mesh(geometry, material);
        cube.position.y = 1;
        cube.userData.uid = player.uid;
        cube.userData.name = player.name;

        if (player.uid === myUid) {
            localPlayer = cube;
            scene.add(localPlayer);
        } else {
            remotePlayers[player.uid] = cube;
            scene.add(cube);
        }
    });

    const ambientLight = new THREE.AmbientLight(0x404040, 0.1);
    scene.add(ambientLight);

    if (localPlayer) {
        localPlayer.add(camera);
        const flashlight = new THREE.SpotLight(0xffffff, 1.5, 20, Math.PI / 6, 0.3, 1.0);
        flashlight.position.set(0, 1.0, 0);
        flashlight.target.position.set(0, 1.0, -1);
        localPlayer.add(flashlight);
        localPlayer.add(flashlight.target);
    }

    const roomSize = 20;
    const wallHeight = 5;
    const floorGeometry = new THREE.PlaneGeometry(roomSize, roomSize);
    const floorMaterial = new THREE.MeshStandardMaterial({ color: 0x222222, side: THREE.DoubleSide });
    const floor = new THREE.Mesh(floorGeometry, floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);
    const ceiling = new THREE.Mesh(floorGeometry, floorMaterial);
    ceiling.position.y = wallHeight;
    ceiling.rotation.x = Math.PI / 2;
    scene.add(ceiling);
    const wallGeometry = new THREE.PlaneGeometry(roomSize, wallHeight);
    const wallMaterial = new THREE.MeshStandardMaterial({ color: 0x1a1a1a });
    const wall1 = new THREE.Mesh(wallGeometry, wallMaterial);
    wall1.position.set(0, wallHeight / 2, -roomSize / 2);
    scene.add(wall1);
    const wall2 = new THREE.Mesh(wallGeometry, wallMaterial);
    wall2.position.set(0, wallHeight / 2, roomSize / 2);
    wall2.rotation.y = Math.PI;
    scene.add(wall2);
    const wall3 = new THREE.Mesh(wallGeometry, wallMaterial);
    wall3.position.set(-roomSize / 2, wallHeight / 2, 0);
    wall3.rotation.y = Math.PI / 2;
    scene.add(wall3);
    const wall4 = new THREE.Mesh(wallGeometry, wallMaterial);
    wall4.position.set(roomSize / 2, wallHeight / 2, 0);
    wall4.rotation.y = -Math.PI / 2;
    scene.add(wall4);

    if (!roomData.key_found) {
        const keyGeometry = new THREE.BoxGeometry(0.5, 0.5, 0.1);
        const keyMaterial = new THREE.MeshStandardMaterial({ color: 0xffd700, emissive: 0xffd700, emissiveIntensity: 0.5 });
        keyObject = new THREE.Mesh(keyGeometry, keyMaterial);
        keyObject.position.set(roomData.key_position.x, roomData.key_position.y, roomData.key_position.z);
        scene.add(keyObject);
    }

    const aiGeometry = new THREE.BoxGeometry(1.2, 2.5, 1.2);
    const aiMaterial = new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 0.1 });
    listenerAI = new THREE.Mesh(aiGeometry, aiMaterial);
    listenerAI.position.set(roomData.ai_position.x, roomData.ai_position.y, roomData.ai_position.z);
    scene.add(listenerAI);

    setupControls();
    return { localPlayer, remotePlayers };
}

function setupControls() {
    const canvas = document.getElementById('game-canvas');
    let moveState = { forward: false, backward: false, left: false, right: false };

    canvas.addEventListener('click', () => {
        if (!isSpectating) canvas.requestPointerLock();
    });

    document.addEventListener('mousemove', (event) => {
        if (document.pointerLockElement === canvas && localPlayer && !isSpectating) {
            localPlayer.rotation.y -= event.movementX * 0.002;
            camera.rotation.x -= event.movementY * 0.002;
            camera.rotation.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, camera.rotation.x));
        }
    });

    document.addEventListener('keydown', (event) => {
        if (isSpectating) {
            if (event.code === 'KeyQ') window.cycleSpectateTarget();
            if (event.code === 'KeyC') {
                spectatorCameraMode = spectatorCameraMode === 'third-person' ? 'first-person' : 'third-person';
            }
            return;
        }
        switch (event.code) {
            case 'KeyW': case 'ArrowUp': moveState.forward = true; break;
            case 'KeyS': case 'ArrowDown': moveState.backward = true; break;
            case 'KeyA': case 'ArrowLeft': moveState.left = true; break;
            case 'KeyD': case 'ArrowRight': moveState.right = true; break;
            case 'KeyF':
                broadcastData({ type: 'noise', data: { from: localPlayerUid }});
                break;
        }
    });

    document.addEventListener('keyup', (event) => {
        if (isSpectating) return;
        switch (event.code) {
            case 'KeyW': case 'ArrowUp': moveState.forward = false; break;
            case 'KeyS': case 'ArrowDown': moveState.backward = false; break;
            case 'KeyA': case 'ArrowLeft': moveState.left = false; break;
            case 'KeyD': case 'ArrowRight': moveState.right = false; break;
        }
    });
    controls = moveState;
}

export function startGameLoop(roomId, isHost) {
    const clock = new THREE.Clock();
    const speed = 4.0;

    function animate() {
        requestAnimationFrame(animate);
        const delta = clock.getDelta();

        if (!isSpectating && localPlayer && controls) {
            const moveDirection = new THREE.Vector3();
            if (controls.forward) moveDirection.z = -1;
            if (controls.backward) moveDirection.z = 1;
            if (controls.left) moveDirection.x = -1;
            if (controls.right) moveDirection.x = 1;
            if (moveDirection.length() > 0) {
                moveDirection.normalize();
                moveDirection.applyEuler(localPlayer.rotation);
                localPlayer.position.add(moveDirection.multiplyScalar(speed * delta));
            }
        }

        if (keyObject && localPlayer) {
            if (localPlayer.position.distanceTo(keyObject.position) < 1.5) {
                supabase.from('rooms').update({ key_found: true, key_holder_uid: localPlayerUid }).eq('id', roomId).then();
                scene.remove(keyObject);
                keyObject = null;
            }
        }
        
        if (!isSpectating && localPlayer) {
            broadcastData({
                type: 'position',
                data: { position: localPlayer.position, rotation: { x: 0, y: localPlayer.rotation.y, z: 0 } }
            });
        }
        
        for(const uid in remotePlayers) {
            const player = remotePlayers[uid];
            if(player.targetPosition) player.position.lerp(player.targetPosition, 0.2);
            if(player.targetRotation) player.rotation.y = THREE.MathUtils.lerp(player.rotation.y, player.targetRotation.y, 0.2);
        }

        if (isHost && listenerAI.userData.state === 'hunting') {
            const allLivingPlayers = { ...remotePlayers };
            if (localPlayer && localPlayer.visible) {
                allLivingPlayers[localPlayerUid] = localPlayer;
            }
            
            const targetPlayer = allLivingPlayers[listenerAI.userData.targetUid];

            if (targetPlayer && targetPlayer.visible) {
                const distanceToTarget = listenerAI.position.distanceTo(targetPlayer.position);

                if (distanceToTarget < 1.5) {
                    // *** CÓDIGO CORREGIDO: Llamar a la función de la base de datos ***
                    supabase.rpc('player_caught', {
                        room_id_input: roomId,
                        player_uid_input: targetPlayer.userData.uid
                    }).then();
                } else {
                    const aiSpeed = 1.5;
                    const direction = new THREE.Vector3().subVectors(targetPlayer.position, listenerAI.position).normalize();
                    listenerAI.position.add(direction.multiplyScalar(aiSpeed * delta));
                    broadcastData({ type: 'ai-position', data: listenerAI.position });
                }
            } else {
                supabase.from('rooms').update({ threat_level: 0, ai_state: "dormant" }).eq('id', roomId).then();
            }
        }

        const livingPlayersList = Object.values(remotePlayers).filter(p => p.visible);
        if (localPlayer && localPlayer.visible) livingPlayersList.push(localPlayer);

        if (isHost && livingPlayersList.length === 0 && scene.children.length > 0) {
             supabase.from('rooms').update({ status: 'finished' }).eq('id', roomId).then();
        }

        if (isSpectating) {
            if (livingPlayersList.length > 0) {
                const target = livingPlayersList[spectateTargetIndex % livingPlayersList.length];
                
                if (spectatorCameraMode === 'first-person') {
                    const targetCamera = target.children[0];
                    if (targetCamera) {
                        targetCamera.getWorldPosition(camera.position);
                        targetCamera.getWorldQuaternion(camera.quaternion);
                    }
                } else {
                    const offset = new THREE.Vector3(0, 2, 4);
                    offset.applyQuaternion(target.quaternion);
                    offset.add(target.position);
                    camera.position.lerp(offset, 0.05);
                    camera.lookAt(target.position);
                }
                document.getElementById('spectate-target-name').textContent = target.userData.name;
            } else {
                document.getElementById('spectate-target-name').textContent = "Nadie. Todos han sido capturados.";
            }
        }

        renderer.render(scene, camera);
    }
    animate();
}

export function updateRemotePlayerPosition(uid, data) {
    const player = remotePlayers[uid];
    if (player) {
        player.targetPosition = new THREE.Vector3(data.position.x, data.position.y, data.position.z);
        player.targetRotation = data.rotation;
    }
}

export function updateAIState(aiData) {
    if (listenerAI) {
        if (aiData.state === 'dormant') {
            listenerAI.position.set(aiData.position.x, aiData.position.y, aiData.position.z);
        }
        listenerAI.userData.state = aiData.state;
        listenerAI.userData.targetUid = aiData.targetUid;
    }
}

export function updateAIPositionFromBroadcast(position) {
    if (listenerAI) {
        listenerAI.position.lerp(position, 0.3);
    }
}

window.removeKeyFromScene = () => {
    if (keyObject) {
        scene.remove(keyObject);
        keyObject = null;
    }
};

window.updateCaughtPlayers = (caughtPlayers) => {
    for (const uid in remotePlayers) {
        if (caughtPlayers.includes(uid) && remotePlayers[uid].visible) {
            remotePlayers[uid].visible = false;
            scene.remove(remotePlayers[uid]);
        }
    }
    if (localPlayer && caughtPlayers.includes(localPlayer.userData.uid) && localPlayer.visible) {
        localPlayer.visible = false;
        scene.remove(localPlayer);
    }
};

window.enterSpectateMode = () => {
    isSpectating = true;
    if (localPlayer) {
        localPlayer.remove(camera);
    }
    document.exitPointerLock();
    spectatorLight = new THREE.AmbientLight(0x404040, 0.5);
    scene.add(spectatorLight);
};

window.cycleSpectateTarget = () => {
    const livingPlayers = Object.values(remotePlayers).filter(p => p.visible);
    if (localPlayer && localPlayer.visible) livingPlayers.push(localPlayer);
    if (livingPlayers.length > 0) {
        spectateTargetIndex = (spectateTargetIndex + 1) % livingPlayers.length;
    }
};

window.cleanupGame = () => {
    if (spectatorLight) {
        scene.remove(spectatorLight);
        spectatorLight = null;
    }
    isSpectating = false;
};