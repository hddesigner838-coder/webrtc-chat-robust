// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs-extra');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ["http://localhost:3000", "http://127.0.0.1:5500", "*"], // Ajoute ton domaine
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

// Structure de données adaptée à ton app
const users = new Map(); // socketId -> userInfo
const rooms = new Map(); // roomId -> Set of socketIds
const userSockets = new Map(); // userId -> socketId (pour retrouver rapidement)
const activeCalls = new Map(); // callId -> callInfo

// Fichier de persistance
const DATA_DIR = path.join(__dirname, 'data');
fs.ensureDirSync(DATA_DIR);

// Charger les données au démarrage
async function loadData() {
  try {
    // Charger les messages hors ligne
    const messagesFile = path.join(DATA_DIR, 'offline_messages.json');
    if (await fs.pathExists(messagesFile)) {
      const data = await fs.readJson(messagesFile);
      Object.keys(data).forEach(key => {
        if (!offlineMessages.has(key)) {
          offlineMessages.set(key, data[key]);
        }
      });
      console.log(`📦 ${offlineMessages.size} utilisateurs avec messages hors ligne`);
    }
  } catch (error) {
    console.error('Erreur chargement:', error);
  }
}

// Sauvegarder les données
async function saveData() {
  try {
    const messagesFile = path.join(DATA_DIR, 'offline_messages.json');
    const messagesData = Object.fromEntries(offlineMessages);
    await fs.writeJson(messagesFile, messagesData, { spaces: 2 });
  } catch (error) {
    console.error('Erreur sauvegarde:', error);
  }
}

// Charger au démarrage
loadData();

io.on('connection', (socket) => {
  console.log(`🟢 Nouvelle connexion: ${socket.id}`);

  // ============================================
  // AUTHENTIFICATION (adapté à ton Google Login)
  // ============================================
  socket.on('authenticate', (userData) => {
    try {
      const { userId, firstName, lastName, email, photo } = userData;
      
      socket.userId = userId || uuidv4();
      socket.firstName = firstName || '';
      socket.lastName = lastName || '';
      socket.fullName = `${firstName || ''} ${lastName || ''}`.trim() || 'Utilisateur';
      socket.email = email || '';
      socket.photo = photo || '';
      socket.connected = true;
      socket.lastSeen = Date.now();
      
      // Stocker l'utilisateur
      users.set(socket.id, {
        socketId: socket.id,
        userId: socket.userId,
        firstName: socket.firstName,
        lastName: socket.lastName,
        fullName: socket.fullName,
        email: socket.email,
        photo: socket.photo,
        roomId: socket.room || null,
        connected: true,
        lastSeen: Date.now()
      });
      
      // Index pour recherche par userId
      userSockets.set(socket.userId, socket.id);
      
      console.log(`👤 Authentifié: ${socket.fullName} (${socket.userId})`);
      
      // Envoyer confirmation avec messages en attente
      const pendingMessages = offlineMessages.get(socket.userId) || [];
      socket.emit('authenticated', {
        success: true,
        userId: socket.userId,
        pendingMessages: pendingMessages,
        onlineUsers: getOnlineUsers()
      });
      
      // Notifier les autres utilisateurs
      socket.broadcast.emit('user-online', {
        userId: socket.userId,
        fullName: socket.fullName,
        photo: socket.photo,
        socketId: socket.id
      });
      
      // Vider les messages hors ligne après envoi
      if (pendingMessages.length > 0) {
        offlineMessages.delete(socket.userId);
        saveData();
      }
      
    } catch (error) {
      console.error('Erreur authentification:', error);
      socket.emit('authenticated', { success: false, error: error.message });
    }
  });

  // ============================================
  // CHAT PRIVÉ (adapté à ta structure Xano)
  // ============================================
  socket.on('start-private-chat', ({ targetUserId, targetUserName, targetUserPhoto }) => {
    try {
      // Créer un ID de room unique pour le chat privé
      const roomId = [socket.userId, targetUserId].sort().join('-');
      
      // Rejoindre la room
      socket.join(roomId);
      
      // Stocker la room pour l'utilisateur
      if (!rooms.has(roomId)) {
        rooms.set(roomId, new Set());
      }
      rooms.get(roomId).add(socket.id);
      
      // Mettre à jour l'utilisateur
      const user = users.get(socket.id);
      if (user) user.roomId = roomId;
      
      // Vérifier si l'autre utilisateur est en ligne
      const targetSocketId = userSockets.get(targetUserId);
      const isTargetOnline = targetSocketId && users.get(targetSocketId)?.connected;
      
      socket.emit('private-chat-started', {
        roomId,
        targetUserId,
        targetUserName,
        targetUserPhoto,
        isOnline: isTargetOnline
      });
      
      console.log(`💬 Chat privé: ${socket.fullName} avec ${targetUserName} (${roomId})`);
      
    } catch (error) {
      console.error('Erreur start-private-chat:', error);
    }
  });

  // ============================================
  // MESSAGES (adapté à ton système)
  // ============================================
  socket.on('send-message', async (data, ack) => {
    try {
      const { content, type = 'text', targetUserId, roomId, metadata = {} } = data;
      
      const messageId = uuidv4();
      const timestamp = Date.now();
      
      const messageData = {
        messageId,
        fromUserId: socket.userId,
        fromFullName: socket.fullName,
        fromPhoto: socket.photo,
        content,
        type,
        metadata,
        timestamp,
        status: 'sent'
      };
      
      // Si message privé
      if (targetUserId) {
        messageData.targetUserId = targetUserId;
        
        // Créer ou utiliser la room privée
        const privateRoomId = [socket.userId, targetUserId].sort().join('-');
        
        const targetSocketId = userSockets.get(targetUserId);
        const isTargetOnline = targetSocketId && users.get(targetSocketId)?.connected;
        
        if (isTargetOnline) {
          // Envoyer directement
          io.to(targetSocketId).emit('new-message', messageData);
          
          // Ajouter à la room pour l'historique
          socket.to(privateRoomId).emit('new-message', messageData);
          
          messageData.status = 'delivered';
          
          if (ack) ack({ success: true, messageId, status: 'delivered' });
        } else {
          // Stocker pour hors ligne
          if (!offlineMessages.has(targetUserId)) {
            offlineMessages.set(targetUserId, []);
          }
          offlineMessages.get(targetUserId).push({
            ...messageData,
            isOffline: true
          });
          await saveData();
          
          messageData.status = 'queued';
          
          if (ack) ack({ success: true, messageId, status: 'queued' });
        }
      } 
      // Si message dans une room existante
      else if (roomId) {
        io.to(roomId).emit('new-message', messageData);
        if (ack) ack({ success: true, messageId });
      }
      
      // Sauvegarder dans l'historique
      await saveMessageToHistory(messageData);
      
      // Confirmation à l'expéditeur
      socket.emit('message-sent', {
        ...messageData,
        status: messageData.status || 'sent'
      });
      
    } catch (error) {
      console.error('Erreur envoi message:', error);
      if (ack) ack({ success: false, error: error.message });
    }
  });

  // ============================================
  // WEBRTC - APPELS AUDIO/VIDÉO
  // ============================================
  socket.on('webrtc-call', ({ targetUserId, offer, isVideo = true }) => {
    try {
      const callId = uuidv4();
      const targetSocketId = userSockets.get(targetUserId);
      
      if (!targetSocketId) {
        socket.emit('call-failed', { reason: 'user-offline' });
        return;
      }
      
      // Vérifier si l'utilisateur n'est pas déjà en appel
      if (isUserInCall(targetUserId)) {
        socket.emit('call-failed', { reason: 'user-busy' });
        return;
      }
      
      // Créer l'appel
      activeCalls.set(callId, {
        callId,
        callerId: socket.userId,
        callerSocketId: socket.id,
        callerInfo: {
          fullName: socket.fullName,
          photo: socket.photo
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
      
    } catch (error) {
      console.error('Erreur webrtc-call:', error);
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
        // Accepter l'appel
        call.status = 'active';
        call.answeredAt = Date.now();
        
        io.to(call.callerSocketId).emit('call-accepted', {
          callId,
          answer,
          targetInfo: {
            fullName: socket.fullName,
            photo: socket.photo
          }
        });
        
        console.log(`✅ Appel ${callId} accepté`);
      } else {
        // Refuser l'appel
        activeCalls.delete(callId);
        
        io.to(call.callerSocketId).emit('call-rejected', {
          callId,
          reason: 'user-declined'
        });
        
        console.log(`❌ Appel ${callId} refusé`);
      }
      
    } catch (error) {
      console.error('Erreur webrtc-answer:', error);
    }
  });

  socket.on('webrtc-ice-candidate', ({ targetUserId, candidate }) => {
    try {
      const targetSocketId = userSockets.get(targetUserId);
      if (targetSocketId) {
        io.to(targetSocketId).emit('webrtc-ice-candidate', {
          fromUserId: socket.userId,
          candidate
        });
      }
    } catch (error) {
      console.error('Erreur webrtc-ice-candidate:', error);
    }
  });

  socket.on('end-call', ({ callId, targetUserId }) => {
    try {
      const call = activeCalls.get(callId);
      
      if (call) {
        const targetSocketId = userSockets.get(targetUserId);
        if (targetSocketId) {
          io.to(targetSocketId).emit('call-ended', {
            callId,
            endedBy: socket.userId
          });
        }
        
        activeCalls.delete(callId);
      }
      
      console.log(`📴 Appel ${callId} terminé`);
      
    } catch (error) {
      console.error('Erreur end-call:', error);
    }
  });

  socket.on('call-timeout', ({ callId }) => {
    const call = activeCalls.get(callId);
    if (call) {
      io.to(call.targetSocketId).emit('call-missed', {
        callId,
        callerId: call.callerId
      });
      activeCalls.delete(callId);
    }
  });

  // ============================================
  // TYPING INDICATORS
  // ============================================
  socket.on('typing', ({ targetUserId, isTyping }) => {
    const targetSocketId = userSockets.get(targetUserId);
    if (targetSocketId) {
      io.to(targetSocketId).emit('user-typing', {
        userId: socket.userId,
        fullName: socket.fullName,
        isTyping
      });
    }
  });

  // ============================================
  // MESSAGE READ RECEIPTS
  // ============================================
  socket.on('mark-read', ({ messageIds, fromUserId }) => {
    const fromSocketId = userSockets.get(fromUserId);
    if (fromSocketId) {
      io.to(fromSocketId).emit('messages-read', {
        byUserId: socket.userId,
        messageIds,
        timestamp: Date.now()
      });
    }
  });

  // ============================================
  // DÉCONNEXION
  // ============================================
  socket.on('disconnect', () => {
    console.log(`🔴 Déconnexion: ${socket.fullName || socket.id}`);
    
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
          const otherSocketId = userSockets.get(otherId);
          
          if (otherSocketId) {
            io.to(otherSocketId).emit('call-ended', {
              callId,
              reason: 'user-disconnected'
            });
          }
          
          activeCalls.delete(callId);
        }
      });
    }
    
    // Retirer des rooms
    if (socket.room && rooms.has(socket.room)) {
      rooms.get(socket.room).delete(socket.id);
    }
    
    users.delete(socket.id);
  });
});

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
        photo: user.photo,
        socketId
      });
    }
  });
  return online;
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

async function saveMessageToHistory(message) {
  try {
    const historyFile = path.join(DATA_DIR, 'message_history.json');
    let history = [];
    
    if (await fs.pathExists(historyFile)) {
      history = await fs.readJson(historyFile);
    }
    
    // Garder seulement les 10000 derniers messages
    history.push(message);
    if (history.length > 10000) {
      history = history.slice(-10000);
    }
    
    await fs.writeJson(historyFile, history, { spaces: 2 });
  } catch (error) {
    console.error('Erreur sauvegarde historique:', error);
  }
}

// API REST pour compatibilité
app.get('/api/online-users', (req, res) => {
  res.json(getOnlineUsers());
});

app.get('/api/user-status/:userId', (req, res) => {
  const { userId } = req.params;
  const socketId = userSockets.get(userId);
  const user = socketId ? users.get(socketId) : null;
  
  res.json({
    userId,
    online: !!user?.connected,
    lastSeen: user?.lastSeen || null,
    inCall: isUserInCall(userId)
  });
});

// Nettoyage périodique
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
  
  saveData();
  
  // Nettoyer les appels trop vieux
  activeCalls.forEach((call, callId) => {
    if (now - call.startTime > 30 * 60 * 1000) { // 30 minutes
      activeCalls.delete(callId);
    }
  });
  
}, 60 * 60 * 1000); // Toutes les heures

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Serveur WebRTC démarré sur http://localhost:${PORT}`);
  console.log(`📡 WebSocket prêt pour les connexions`);
});
