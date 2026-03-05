// ============================================
// SERVEUR WEBRTC POUR APPLICATION DE CHAT
// ============================================

// Chargement des variables d'environnement (optionnel)
try {
    require('dotenv').config();
} catch (e) {
    console.log('📝 dotenv non installé, utilisation des variables système');
}

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs-extra');
const path = require('path');

// ============================================
// CONFIGURATION
// ============================================
const app = express();
const server = http.createServer(app);

// Configuration CORS flexible
const allowedOrigins = process.env.CORS_ORIGIN 
    ? process.env.CORS_ORIGIN.split(',') 
    : ["http://localhost:3000", "http://127.0.0.1:5500", "http://localhost:5500", "*"];

const io = new Server(server, {
    cors: {
        origin: allowedOrigins,
        methods: ["GET", "POST"],
        credentials: true
    },
    maxHttpBufferSize: 1e8, // 100MB pour les fichiers
    pingTimeout: 60000,
    pingInterval: 25000
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// STRUCTURES DE DONNÉES
// ============================================
const users = new Map();           // socketId -> userInfo
const rooms = new Map();           // roomId -> Set of socketIds
const userSockets = new Map();     // userId -> socketId
const activeCalls = new Map();     // callId -> callInfo
const offlineMessages = new Map(); // userId -> [messages]
const typingUsers = new Map();     // roomId -> Set of userIds

// ============================================
// PERSISTANCE DES DONNÉES
// ============================================
const DATA_DIR = path.join(__dirname, 'data');
fs.ensureDirSync(DATA_DIR);

// Charger les messages hors ligne
async function loadOfflineMessages() {
    try {
        const messagesFile = path.join(DATA_DIR, 'offline_messages.json');
        if (await fs.pathExists(messagesFile)) {
            const data = await fs.readJson(messagesFile);
            Object.keys(data).forEach(key => {
                offlineMessages.set(key, data[key]);
            });
            console.log(`📦 ${offlineMessages.size} utilisateurs avec messages hors ligne`);
        }
    } catch (error) {
        console.error('Erreur chargement messages:', error);
    }
}

// Sauvegarder les messages hors ligne
async function saveOfflineMessages() {
    try {
        const messagesFile = path.join(DATA_DIR, 'offline_messages.json');
        const messagesData = Object.fromEntries(offlineMessages);
        await fs.writeJson(messagesFile, messagesData, { spaces: 2 });
    } catch (error) {
        console.error('Erreur sauvegarde messages:', error);
    }
}

// Charger l'historique d'une room
async function getRoomHistory(roomId, since = 0) {
    const historyFile = path.join(DATA_DIR, `room_${roomId}.json`);
    try {
        if (await fs.pathExists(historyFile)) {
            const messages = await fs.readJson(historyFile);
            return messages.filter(m => m.timestamp > since);
        }
    } catch (error) {
        console.error('Erreur lecture historique:', error);
    }
    return [];
}

// Sauvegarder l'historique d'une room
async function saveRoomHistory(roomId, messages) {
    const historyFile = path.join(DATA_DIR, `room_${roomId}.json`);
    try {
        // Garder seulement les 1000 derniers messages
        const recent = messages.slice(-1000);
        await fs.writeJson(historyFile, recent, { spaces: 2 });
    } catch (error) {
        console.error('Erreur sauvegarde historique:', error);
    }
}

// Charger au démarrage
loadOfflineMessages();

// ============================================
// FONCTIONS UTILITAIRES
// ============================================

function getOnlineUsers() {
    const online = [];
    users.forEach((user, socketId) => {
        if (user.connected && user.userId) {
            online.push({
                userId: user.userId,
                fullName: user.fullName,
                firstName: user.firstName,
                lastName: user.lastName,
                email: user.email,
                photo: user.photo,
                socketId
            });
        }
    });
    return online;
}

async function findUserSocket(userId) {
    const socketId = userSockets.get(userId);
    if (socketId && users.get(socketId)?.connected) {
        return socketId;
    }
    return null;
}

function isUserInCall(userId) {
    for (let [_, call] of activeCalls) {
        if ((call.callerId === userId || call.targetId === userId) && 
            call.status === 'active') {
            return true;
        }
    }
    return false;
}

async function addOfflineMessage(userId, message) {
    if (!offlineMessages.has(userId)) {
        offlineMessages.set(userId, []);
    }
    offlineMessages.get(userId).push({
        ...message,
        queuedAt: Date.now()
    });
    await saveOfflineMessages();
}

// ============================================
// SOCKET.IO - GESTION DES CONNEXIONS
// ============================================
io.on('connection', (socket) => {
    console.log(`🟢 Nouvelle connexion: ${socket.id} (${new Date().toLocaleTimeString()})`);

    // ============================================
    // AUTHENTIFICATION
    // ============================================
    socket.on('authenticate', (userData) => {
        try {
            const { 
                id: userId, 
                firstName = '', 
                lastName = '', 
                email = '', 
                photo = '',
                fullName: providedFullName
            } = userData;
            
            socket.userId = userId || uuidv4();
            socket.firstName = firstName || '';
            socket.lastName = lastName || '';
            socket.fullName = providedFullName || `${firstName} ${lastName}`.trim() || 'Utilisateur';
            socket.email = email || '';
            socket.photo = photo || 'https://via.placeholder.com/150';
            socket.connected = true;
            socket.lastSeen = Date.now();
            socket.join(`user:${socket.userId}`); // Room personnelle pour les messages privés
            
            // Stocker l'utilisateur
            const userInfo = {
                socketId: socket.id,
                userId: socket.userId,
                firstName: socket.firstName,
                lastName: socket.lastName,
                fullName: socket.fullName,
                email: socket.email,
                photo: socket.photo,
                roomId: socket.room || null,
                connected: true,
                lastSeen: Date.now(),
                deviceInfo: userData.deviceInfo || {}
            };
            
            users.set(socket.id, userInfo);
            userSockets.set(socket.userId, socket.id);
            
            console.log(`👤 Authentifié: ${socket.fullName} (${socket.userId})`);
            
            // Récupérer les messages en attente
            const pendingMessages = offlineMessages.get(socket.userId) || [];
            if (pendingMessages.length > 0) {
                offlineMessages.delete(socket.userId);
                saveOfflineMessages();
            }
            
            // Envoyer confirmation
            socket.emit('authenticated', {
                success: true,
                userId: socket.userId,
                fullName: socket.fullName,
                pendingMessages: pendingMessages,
                onlineUsers: getOnlineUsers()
            });
            
            // Notifier les autres utilisateurs
            socket.broadcast.emit('user-online', {
                userId: socket.userId,
                fullName: socket.fullName,
                firstName: socket.firstName,
                lastName: socket.lastName,
                photo: socket.photo,
                socketId: socket.id
            });
            
        } catch (error) {
            console.error('Erreur authentification:', error);
            socket.emit('authenticated', { success: false, error: error.message });
        }
    });

    // ============================================
    // GESTION DES ROOMS/CHATS PRIVÉS
    // ============================================
    socket.on('join-chat', ({ targetUserId, roomId: providedRoomId }) => {
        try {
            let roomId = providedRoomId;
            
            // Si c'est un chat privé, créer un ID de room unique
            if (targetUserId && !roomId) {
                roomId = [socket.userId, targetUserId].sort().join('-');
            }
            
            if (!roomId) {
                socket.emit('error', { message: 'ID de room requis' });
                return;
            }
            
            // Quitter les anciennes rooms (sauf la room personnelle)
            if (socket.room && socket.room !== roomId) {
                socket.leave(socket.room);
                if (rooms.has(socket.room)) {
                    rooms.get(socket.room).delete(socket.id);
                    
                    // Notifier les autres
                    socket.to(socket.room).emit('user-left-room', {
                        userId: socket.userId,
                        fullName: socket.fullName
                    });
                }
            }
            
            // Rejoindre la nouvelle room
            socket.room = roomId;
            socket.join(roomId);
            
            if (!rooms.has(roomId)) {
                rooms.set(roomId, new Set());
            }
            rooms.get(roomId).add(socket.id);
            
            // Mettre à jour l'utilisateur
            const user = users.get(socket.id);
            if (user) {
                user.roomId = roomId;
            }
            
            // Récupérer les utilisateurs dans la room
            const roomUsers = [];
            rooms.get(roomId).forEach(sid => {
                const roomUser = users.get(sid);
                if (roomUser && sid !== socket.id) {
                    roomUsers.push({
                        socketId: sid,
                        userId: roomUser.userId,
                        fullName: roomUser.fullName,
                        photo: roomUser.photo
                    });
                }
            });
            
            // Récupérer l'historique
            getRoomHistory(roomId).then(history => {
                socket.emit('chat-joined', {
                    roomId,
                    users: roomUsers,
                    history: history.slice(-50), // Derniers 50 messages
                    timestamp: Date.now()
                });
            });
            
            // Notifier les autres
            socket.to(roomId).emit('user-joined-chat', {
                userId: socket.userId,
                fullName: socket.fullName,
                photo: socket.photo,
                socketId: socket.id,
                timestamp: Date.now()
            });
            
            console.log(`💬 ${socket.fullName} a rejoint ${roomId}`);
            
        } catch (error) {
            console.error('Erreur join-chat:', error);
        }
    });

    // ============================================
    // ENVOI DE MESSAGES
    // ============================================
    socket.on('send-message', async (data, ack) => {
        try {
            const { content, type = 'text', targetUserId, roomId: providedRoomId, metadata = {} } = data;
            
            const messageId = uuidv4();
            const timestamp = Date.now();
            
            // Déterminer la room cible
            let targetRoom = providedRoomId;
            if (targetUserId) {
                targetRoom = [socket.userId, targetUserId].sort().join('-');
            } else if (socket.room) {
                targetRoom = socket.room;
            }
            
            if (!targetRoom) {
                if (ack) ack({ success: false, error: 'Aucune room cible' });
                return;
            }
            
            const messageData = {
                messageId,
                fromUserId: socket.userId,
                fromFullName: socket.fullName,
                fromPhoto: socket.photo,
                content,
                type,
                metadata,
                timestamp,
                roomId: targetRoom,
                status: 'sent',
                deliveredTo: [],
                readBy: []
            };
            
            // Message privé
            if (targetUserId) {
                const targetSocketId = await findUserSocket(targetUserId);
                
                if (targetSocketId) {
                    // Destinataire connecté
                    messageData.status = 'delivered';
                    messageData.deliveredTo.push(targetUserId);
                    
                    io.to(targetSocketId).emit('new-message', messageData);
                    
                    if (ack) ack({ 
                        success: true, 
                        messageId, 
                        status: 'delivered',
                        timestamp 
                    });
                } else {
                    // Destinataire hors ligne
                    await addOfflineMessage(targetUserId, {
                        ...messageData,
                        isOffline: true
                    });
                    
                    messageData.status = 'queued';
                    
                    if (ack) ack({ 
                        success: true, 
                        messageId, 
                        status: 'queued',
                        timestamp 
                    });
                }
            } 
            // Message dans une room
            else {
                io.to(targetRoom).emit('new-message', messageData);
                if (ack) ack({ success: true, messageId, status: 'sent', timestamp });
            }
            
            // Sauvegarder dans l'historique
            const history = await getRoomHistory(targetRoom);
            history.push(messageData);
            await saveRoomHistory(targetRoom, history);
            
            // Confirmation à l'expéditeur
            socket.emit('message-sent', {
                ...messageData,
                status: messageData.status
            });
            
        } catch (error) {
            console.error('Erreur envoi message:', error);
            if (ack) ack({ success: false, error: error.message });
        }
    });

    // ============================================
    // ACQUITTEMENTS DE LECTURE
    // ============================================
    socket.on('mark-read', async ({ messageIds, fromUserId, roomId }) => {
        try {
            const targetRoom = roomId || [fromUserId, socket.userId].sort().join('-');
            
            // Mettre à jour l'historique
            const history = await getRoomHistory(targetRoom);
            let updated = false;
            
            history.forEach(msg => {
                if (messageIds.includes(msg.messageId) && !msg.readBy.includes(socket.userId)) {
                    msg.readBy.push(socket.userId);
                    updated = true;
                }
            });
            
            if (updated) {
                await saveRoomHistory(targetRoom, history);
            }
            
            // Notifier l'expéditeur
            const fromSocketId = await findUserSocket(fromUserId);
            if (fromSocketId) {
                io.to(fromSocketId).emit('messages-read', {
                    byUserId: socket.userId,
                    byFullName: socket.fullName,
                    messageIds,
                    timestamp: Date.now()
                });
            }
            
        } catch (error) {
            console.error('Erreur mark-read:', error);
        }
    });

    // ============================================
    // INDICATEURS DE FRAPPE
    // ============================================
    socket.on('typing', ({ targetUserId, isTyping }) => {
        try {
            const roomId = [socket.userId, targetUserId].sort().join('-');
            
            if (!typingUsers.has(roomId)) {
                typingUsers.set(roomId, new Set());
            }
            
            if (isTyping) {
                typingUsers.get(roomId).add(socket.userId);
            } else {
                typingUsers.get(roomId).delete(socket.userId);
            }
            
            // Notifier l'autre utilisateur
            findUserSocket(targetUserId).then(targetSocketId => {
                if (targetSocketId) {
                    io.to(targetSocketId).emit('user-typing', {
                        userId: socket.userId,
                        fullName: socket.fullName,
                        isTyping
                    });
                }
            });
            
        } catch (error) {
            console.error('Erreur typing:', error);
        }
    });

    // ============================================
    // WEBRTC - SIGNALISATION POUR APPELS
    // ============================================
    socket.on('webrtc-offer', ({ targetUserId, offer, isVideo = true }) => {
        try {
            const callId = uuidv4();
            
            findUserSocket(targetUserId).then(targetSocketId => {
                if (!targetSocketId) {
                    socket.emit('call-failed', { 
                        reason: 'user-offline',
                        message: "L'utilisateur n'est pas en ligne"
                    });
                    return;
                }
                
                // Vérifier si l'utilisateur n'est pas déjà en appel
                if (isUserInCall(targetUserId)) {
                    socket.emit('call-failed', { 
                        reason: 'user-busy',
                        message: "L'utilisateur est déjà en appel"
                    });
                    return;
                }
                
                // Créer l'appel
                activeCalls.set(callId, {
                    callId,
                    callerId: socket.userId,
                    callerSocketId: socket.id,
                    callerInfo: {
                        fullName: socket.fullName,
                        photo: socket.photo,
                        firstName: socket.firstName,
                        lastName: socket.lastName
                    },
                    targetId: targetUserId,
                    targetSocketId,
                    isVideo,
                    startTime: Date.now(),
                    status: 'ringing'
                });
                
                // Envoyer la demande d'appel
                io.to(targetSocketId).emit('incoming-call', {
                    callId,
                    callerId: socket.userId,
                    callerInfo: {
                        fullName: socket.fullName,
                        photo: socket.photo
                    },
                    offer,
                    isVideo
                });
                
                console.log(`📞 Appel ${isVideo ? 'vidéo' : 'audio'} de ${socket.fullName} vers ${targetUserId}`);
                
                // Timeout après 30 secondes
                setTimeout(() => {
                    const call = activeCalls.get(callId);
                    if (call && call.status === 'ringing') {
                        io.to(targetSocketId).emit('call-missed', {
                            callId,
                            callerId: socket.userId,
                            callerName: socket.fullName
                        });
                        
                        socket.emit('call-timeout', {
                            callId,
                            reason: 'no-answer'
                        });
                        
                        activeCalls.delete(callId);
                    }
                }, 30000);
            });
            
        } catch (error) {
            console.error('Erreur webrtc-offer:', error);
        }
    });

    socket.on('webrtc-answer', ({ callId, answer, accept = true }) => {
        try {
            const call = activeCalls.get(callId);
            
            if (!call) {
                socket.emit('call-error', { message: 'Appel introuvable' });
                return;
            }
            
            if (accept) {
                call.status = 'active';
                call.answeredAt = Date.now();
                
                io.to(call.callerSocketId).emit('call-accepted', {
                    callId,
                    answer,
                    targetInfo: {
                        userId: socket.userId,
                        fullName: socket.fullName,
                        photo: socket.photo
                    }
                });
                
                console.log(`✅ Appel ${callId} accepté`);
            } else {
                activeCalls.delete(callId);
                
                io.to(call.callerSocketId).emit('call-rejected', {
                    callId,
                    reason: 'user-declined',
                    message: "L'utilisateur a refusé l'appel"
                });
                
                console.log(`❌ Appel ${callId} refusé`);
            }
            
        } catch (error) {
            console.error('Erreur webrtc-answer:', error);
        }
    });

    socket.on('webrtc-ice-candidate', ({ targetUserId, candidate }) => {
        try {
            findUserSocket(targetUserId).then(targetSocketId => {
                if (targetSocketId) {
                    io.to(targetSocketId).emit('webrtc-ice-candidate', {
                        fromUserId: socket.userId,
                        candidate
                    });
                }
            });
        } catch (error) {
            console.error('Erreur webrtc-ice-candidate:', error);
        }
    });

    socket.on('end-call', ({ callId, targetUserId }) => {
        try {
            const call = activeCalls.get(callId);
            
            if (call) {
                findUserSocket(targetUserId).then(targetSocketId => {
                    if (targetSocketId) {
                        io.to(targetSocketId).emit('call-ended', {
                            callId,
                            endedBy: socket.userId,
                            endedByName: socket.fullName,
                            timestamp: Date.now()
                        });
                    }
                });
                
                activeCalls.delete(callId);
            }
            
            console.log(`📴 Appel ${callId} terminé par ${socket.fullName}`);
            
        } catch (error) {
            console.error('Erreur end-call:', error);
        }
    });

    socket.on('call-timeout', ({ callId }) => {
        const call = activeCalls.get(callId);
        if (call) {
            findUserSocket(call.targetId).then(targetSocketId => {
                if (targetSocketId) {
                    io.to(targetSocketId).emit('call-missed', {
                        callId,
                        callerId: call.callerId,
                        callerName: call.callerInfo.fullName
                    });
                }
            });
            activeCalls.delete(callId);
        }
    });

    // ============================================
    // DÉCONNEXION
    // ============================================
    socket.on('disconnect', () => {
        console.log(`🔴 Déconnexion: ${socket.fullName || socket.id} (${new Date().toLocaleTimeString()})`);
        
        if (socket.userId) {
            // Mettre à jour le statut
            const user = users.get(socket.id);
            if (user) {
                user.connected = false;
                user.lastSeen = Date.now();
            }
            
            // Supprimer des index
            userSockets.delete(socket.userId);
            
            // Notifier les autres
            socket.broadcast.emit('user-offline', {
                userId: socket.userId,
                fullName: socket.fullName,
                lastSeen: Date.now()
            });
            
            // Nettoyer les appels actifs
            activeCalls.forEach((call, callId) => {
                if (call.callerId === socket.userId || call.targetId === socket.userId) {
                    const otherId = call.callerId === socket.userId ? call.targetId : call.callerId;
                    
                    findUserSocket(otherId).then(otherSocketId => {
                        if (otherSocketId) {
                            io.to(otherSocketId).emit('call-ended', {
                                callId,
                                reason: 'user-disconnected',
                                message: "L'utilisateur s'est déconnecté"
                            });
                        }
                    });
                    
                    activeCalls.delete(callId);
                }
            });
            
            // Nettoyer les indicateurs de frappe
            typingUsers.forEach((users, roomId) => {
                if (users.has(socket.userId)) {
                    users.delete(socket.userId);
                    
                    // Notifier l'autre utilisateur
                    const otherUserId = roomId.split('-').find(id => id !== socket.userId);
                    if (otherUserId) {
                        findUserSocket(otherUserId).then(otherSocketId => {
                            if (otherSocketId) {
                                io.to(otherSocketId).emit('user-typing', {
                                    userId: socket.userId,
                                    fullName: socket.fullName,
                                    isTyping: false
                                });
                            }
                        });
                    }
                }
            });
        }
        
        // Retirer des rooms
        if (socket.room && rooms.has(socket.room)) {
            rooms.get(socket.room).delete(socket.id);
            
            // Notifier les autres
            socket.to(socket.room).emit('user-left-room', {
                userId: socket.userId,
                fullName: socket.fullName,
                timestamp: Date.now()
            });
        }
        
        users.delete(socket.id);
    });
});

// ============================================
// API REST POUR COMPATIBILITÉ
// ============================================

// Santé du serveur
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: Date.now(),
        connections: users.size,
        rooms: rooms.size,
        calls: activeCalls.size,
        environment: process.env.NODE_ENV || 'development',
        uptime: process.uptime()
    });
});

// Statistiques
app.get('/api/stats', (req, res) => {
    res.json({
        onlineUsers: getOnlineUsers().length,
        totalUsers: users.size,
        activeRooms: rooms.size,
        activeCalls: activeCalls.size,
        offlineMessages: offlineMessages.size,
        uptime: process.uptime()
    });
});

// Statut d'un utilisateur
app.get('/api/user-status/:userId', (req, res) => {
    const { userId } = req.params;
    const socketId = userSockets.get(userId);
    const user = socketId ? users.get(socketId) : null;
    
    res.json({
        userId,
        online: !!(user?.connected),
        lastSeen: user?.lastSeen || null,
        inCall: isUserInCall(userId),
        fullName: user?.fullName || null
    });
});

// Liste des utilisateurs en ligne
app.get('/api/online-users', (req, res) => {
    res.json(getOnlineUsers());
});

// ============================================
// NETTOYAGE PÉRIODIQUE
// ============================================
setInterval(() => {
    // Nettoyer les vieux messages (7 jours)
    const now = Date.now();
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
    
    offlineMessages.forEach((messages, userId) => {
        const filtered = messages.filter(m => m.timestamp > weekAgo);
        if (filtered.length === 0) {
            offlineMessages.delete(userId);
        } else {
            offlineMessages.set(userId, filtered);
        }
    });
    
    saveOfflineMessages();
    
    // Nettoyer les appels trop vieux (30 minutes)
    activeCalls.forEach((call, callId) => {
        if (now - call.startTime > 30 * 60 * 1000) {
            activeCalls.delete(callId);
        }
    });
    
    // Nettoyer les utilisateurs inactifs (24h)
    users.forEach((user, socketId) => {
        if (!user.connected && now - user.lastSeen > 24 * 60 * 60 * 1000) {
            users.delete(socketId);
        }
    });
    
}, 60 * 60 * 1000); // Toutes les heures

// ============================================
// DÉMARRAGE DU SERVEUR
// ============================================
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
    console.log('\n' + '='.repeat(50));
    console.log(`🚀 SERVEUR WEBRTC DÉMARRÉ`);
    console.log('='.repeat(50));
    console.log(`📡 Port: ${PORT}`);
    console.log(`🌍 Environnement: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔗 URL locale: http://localhost:${PORT}`);
    
    // Afficher l'IP locale
    const { networkInterfaces } = require('os');
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                console.log(`📱 Réseau local: http://${net.address}:${PORT}`);
            }
        }
    }
    console.log('='.repeat(50) + '\n');
});

// Gestion gracieuse de l'arrêt
process.on('SIGTERM', () => {
    console.log('📴 Arrêt du serveur...');
    saveOfflineMessages().then(() => {
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('📴 Arrêt du serveur...');
    saveOfflineMessages().then(() => {
        process.exit(0);
    });
});
