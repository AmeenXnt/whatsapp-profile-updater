/*const express = require('express');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    Browsers,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('baileys');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode');
const fs = require('fs-extra');
const multer = require('multer');
const path = require('path');

const app = express();
const port = process.env.PORT || 8000;

// --- Setup for file uploads ---
const upload = multer({ dest: 'uploads/' });
fs.ensureDirSync('uploads');

// --- In-memory storage for the socket and connection state ---
let sock = null;
let qrCodeData = null;
let connectionState = 'DISCONNECTED'; // Can be DISCONNECTED, CONNECTING, CONNECTED, ERROR

// --- Helper function to gracefully shut down the socket ---
const shutdownSocket = async () => {
    if (sock) {
        console.log('Shutting down existing socket connection...');
        try {
            // Using logout for a clean disconnect
            await sock.logout();
        } catch (error) {
            console.error('Error during socket logout:', error);
            // Fallback for forceful termination if logout fails
            sock.end(undefined);
        } finally {
            sock = null;
            qrCodeData = null;
            connectionState = 'DISCONNECTED';
            console.log('Socket has been shut down.');
        }
    }
};


// --- Helper function to initialize a new socket connection ---
const initializeSocket = () => {
    // This function will now be called after ensuring any old socket is shut down
    connectionState = 'CONNECTING';
    qrCodeData = null;
    
    async function connectToWhatsApp() {
        const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth_info_baileys'));
        
        // --- Fetch the latest version of WA Web ---
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`);

        sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            // --- Use appropriate browser identity ---
            browser: Browsers.macOS('Desktop'),
            auth: state,
            // --- Connection settings for stability ---
            qrTimeout: 120000, // 2 minutes
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 10000,
            // --- Disable unnecessary features for cleaner connection ---
            syncFullHistory: false,
            markOnlineOnConnect: false,
            fireInitQueries: false,
            generateHighQualityLinkPreview: false,
            patchMessageBeforeSending: (message) => {
                const requiresPatch = !!(
                    message.buttonsMessage ||
                    message.templateMessage ||
                    message.listMessage
                );
                if (requiresPatch) {
                    message = {
                        viewOnceMessage: {
                            message: {
                                messageContextInfo: {
                                    deviceListMetadataVersion: 2,
                                    deviceListMetadata: {},
                                },
                                ...message,
                            },
                        },
                    };
                }
                return message;
            },
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('QR code received.');
                qrCodeData = await qrcode.toDataURL(qr);
            }

            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                const boomError = lastDisconnect?.error instanceof Boom ? lastDisconnect.error : undefined;
                
                console.log('Connection closed. Reason:', lastDisconnect.error);
                if(boomError){
                    console.error('Boom Error Details:', boomError.output);
                }

                // Handle different disconnect reasons
                if (shouldReconnect && lastDisconnect?.error?.output?.statusCode === DisconnectReason.restartRequired) {
                    console.log('Restart required, reconnecting...');
                    setTimeout(() => {
                        connectToWhatsApp().catch(console.error);
                    }, 5000);
                    return;
                }
                
                // For other disconnections, reset state
                sock = null;
                qrCodeData = null;
                connectionState = 'DISCONNECTED';
                
            } else if (connection === 'open') {
                console.log('WhatsApp connection opened successfully.');
                connectionState = 'CONNECTED';
                qrCodeData = null; // QR is no longer needed
            } else if (connection === 'connecting') {
                console.log('Connecting to WhatsApp...');
                connectionState = 'CONNECTING';
            }
        });

        sock.ev.on('creds.update', saveCreds);
        
        // Handle messaging updates to prevent crashes
        sock.ev.on('messages.upsert', () => {
            // Ignore incoming messages to prevent processing overhead
        });
        
        // Handle presence updates
        sock.ev.on('presence.update', () => {
            // Ignore presence updates
        });
    }

    connectToWhatsApp().catch(err => {
        console.error("Failed to connect to WhatsApp:", err);
        connectionState = 'ERROR';
        sock = null;
        qrCodeData = null;
    });
};


// --- API Endpoints ---

// Serve the main HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Endpoint to start the QR connection process
app.get('/connect-qr', async (req, res) => {
    console.log('Received request for QR connection.');
    await shutdownSocket(); // Ensure clean state before starting
    initializeSocket();
    res.json({ message: 'QR connection process initiated.' });
});

// Endpoint for the frontend to poll for status
app.get('/status', (req, res) => {
    res.json({
        state: connectionState,
        qr: qrCodeData
    });
});

// Endpoint to get a pairing code
app.get('/pair-code', async (req, res) => {
    const phoneNumber = req.query.phone;
    if (!phoneNumber) {
        return res.status(400).json({ error: 'Phone number is required' });
    }
    
    console.log(`Received request for pairing code for number: ${phoneNumber}`);
    await shutdownSocket(); // Ensure clean state
    initializeSocket();

    // Reliably wait for the socket to be ready for pairing code request
    let attempts = 0;
    const maxAttempts = 15; // ~30 seconds timeout
    const waitInterval = setInterval(async () => {
        attempts++;
        if (sock && sock.requestPairingCode && sock.authState.creds && !sock.authState.creds.registered) {
            clearInterval(waitInterval);
            try {
                console.log('Socket is ready, requesting pairing code...');
                const code = await sock.requestPairingCode(phoneNumber);
                res.json({ code });
            } catch (e) {
                console.error('Error requesting pairing code:', e);
                res.status(500).json({ error: 'Failed to request pairing code.' });
            }
        } else if (attempts > maxAttempts) {
            clearInterval(waitInterval);
            console.error('Socket initialization timed out for pairing code.');
            res.status(500).json({ error: 'Connection timed out. Please try again.' });
        } else {
             console.log(`Waiting for socket to be ready... Attempt ${attempts}`);
        }
    }, 2000);
});


// Endpoint to handle profile picture upload
app.post('/update-pp', upload.single('profilePic'), async (req, res) => {
    if (connectionState !== 'CONNECTED' || !sock) {
        return res.status(400).json({ success: false, message: 'Not connected to WhatsApp.' });
    }
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'No image file uploaded.' });
    }

    const filePath = req.file.path;
    try {
        const imageBuffer = await fs.readFile(filePath);
        await sock.updateProfilePicture(sock.user.id, imageBuffer);

        res.json({ success: true, message: 'Profile picture updated successfully! Logging out...' });

        // Logout after a short delay
        setTimeout(async () => {
            await shutdownSocket();
            // Clear auth directory only after successful profile update and logout
            try {
                if (fs.existsSync(path.join(__dirname, 'auth_info_baileys'))) {
                    fs.removeSync(path.join(__dirname, 'auth_info_baileys'));
                    console.log('Authentication directory cleared after successful logout.');
                }
            } catch (e) {
                console.error('Error removing authentication directory:', e);
            }
        }, 3000);

    } catch (error) {
        console.error('Failed to update profile picture:', error);
        res.status(500).json({ success: false, message: 'An error occurred while updating the picture.' });
    } finally {
        // Clean up the uploaded file
        try {
            await fs.unlink(filePath);
        } catch (e) {
            console.error('Error removing uploaded file:', e);
        }
    }
});


// --- Start the server ---
app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
});
*/
/*
const express = require('express');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    Browsers,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('baileys');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode');
const fs = require('fs-extra');
const multer = require('multer');
const path = require('path');

const app = express();
const port = process.env.PORT || 8000;

// --- Setup for file uploads ---
const upload = multer({ dest: 'uploads/' });
fs.ensureDirSync('uploads');

// --- In-memory storage for the socket and connection state ---
let sock = null;
let qrCodeData = null;
let connectionState = 'DISCONNECTED'; // Can be DISCONNECTED, CONNECTING, CONNECTED, ERROR

// --- Helper function to gracefully shut down the socket ---
const shutdownSocket = async () => {
    if (sock) {
        console.log('Shutting down existing socket connection...');
        try {
            // Using logout for a clean disconnect
            await sock.logout();
        } catch (error) {
            console.error('Error during socket logout:', error);
            // Fallback for forceful termination if logout fails
            sock.end(undefined);
        } finally {
            sock = null;
            qrCodeData = null;
            connectionState = 'DISCONNECTED';
            console.log('Socket has been shut down.');
        }
    }
};


// --- Helper function to initialize a new socket connection ---
const initializeSocket = () => {
    // This function will now be called after ensuring any old socket is shut down
    connectionState = 'CONNECTING';
    qrCodeData = null;
    
    async function connectToWhatsApp() {
        const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth_info_baileys'));
        
        // --- Fetch the latest version of WA Web ---
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`);

        sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            // --- Use appropriate browser identity ---
            browser: Browsers.macOS('Desktop'),
            auth: state,
            // --- Connection settings for stability ---
            qrTimeout: 120000, // 2 minutes
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 10000,
            // --- Disable unnecessary features for cleaner connection ---
            syncFullHistory: false,
            markOnlineOnConnect: false,
            fireInitQueries: false,
            generateHighQualityLinkPreview: false,
            patchMessageBeforeSending: (message) => {
                const requiresPatch = !!(
                    message.buttonsMessage ||
                    message.templateMessage ||
                    message.listMessage
                );
                if (requiresPatch) {
                    message = {
                        viewOnceMessage: {
                            message: {
                                messageContextInfo: {
                                    deviceListMetadataVersion: 2,
                                    deviceListMetadata: {},
                                },
                                ...message,
                            },
                        },
                    };
                }
                return message;
            },
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('QR code received.');
                qrCodeData = await qrcode.toDataURL(qr);
            }

            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                const boomError = lastDisconnect?.error instanceof Boom ? lastDisconnect.error : undefined;
                
                console.log('Connection closed. Reason:', lastDisconnect.error);
                if(boomError){
                    console.error('Boom Error Details:', boomError.output);
                }

                // Handle different disconnect reasons
                if (shouldReconnect && lastDisconnect?.error?.output?.statusCode === DisconnectReason.restartRequired) {
                    console.log('Restart required, reconnecting...');
                    setTimeout(() => {
                        connectToWhatsApp().catch(console.error);
                    }, 5000);
                    return;
                }
                
                // For other disconnections, reset state
                sock = null;
                qrCodeData = null;
                connectionState = 'DISCONNECTED';
                
            } else if (connection === 'open') {
                console.log('WhatsApp connection opened successfully.');
                connectionState = 'CONNECTED';
                qrCodeData = null; // QR is no longer needed
            } else if (connection === 'connecting') {
                console.log('Connecting to WhatsApp...');
                connectionState = 'CONNECTING';
            }
        });

        sock.ev.on('creds.update', saveCreds);
        
        // Handle messaging updates to prevent crashes
        sock.ev.on('messages.upsert', () => {
            // Ignore incoming messages to prevent processing overhead
        });
        
        // Handle presence updates
        sock.ev.on('presence.update', () => {
            // Ignore presence updates
        });
    }

    connectToWhatsApp().catch(err => {
        console.error("Failed to connect to WhatsApp:", err);
        connectionState = 'ERROR';
        sock = null;
        qrCodeData = null;
    });
};


// --- API Endpoints ---

// Serve the main HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Endpoint to start the QR connection process
app.get('/connect-qr', async (req, res) => {
    console.log('Received request for QR connection.');
    await shutdownSocket(); // Ensure clean state before starting
    initializeSocket();
    res.json({ message: 'QR connection process initiated.' });
});

// Endpoint for the frontend to poll for status
app.get('/status', (req, res) => {
    res.json({
        state: connectionState,
        qr: qrCodeData
    });
});

// Endpoint to get a pairing code
app.get('/pair-code', async (req, res) => {
    const phoneNumber = req.query.phone;
    if (!phoneNumber) {
        return res.status(400).json({ error: 'Phone number is required' });
    }
    
    console.log(`Received request for pairing code for number: ${phoneNumber}`);
    await shutdownSocket(); // Ensure clean state
    initializeSocket();

    // Reliably wait for the socket to be ready for pairing code request
    let attempts = 0;
    const maxAttempts = 15; // ~30 seconds timeout
    const waitInterval = setInterval(async () => {
        attempts++;
        if (sock && sock.requestPairingCode && sock.authState.creds && !sock.authState.creds.registered) {
            clearInterval(waitInterval);
            try {
                console.log('Socket is ready, requesting pairing code...');
                const code = await sock.requestPairingCode(phoneNumber);
                res.json({ code });
            } catch (e) {
                console.error('Error requesting pairing code:', e);
                res.status(500).json({ error: 'Failed to request pairing code.' });
            }
        } else if (attempts > maxAttempts) {
            clearInterval(waitInterval);
            console.error('Socket initialization timed out for pairing code.');
            res.status(500).json({ error: 'Connection timed out. Please try again.' });
        } else {
             console.log(`Waiting for socket to be ready... Attempt ${attempts}`);
        }
    }, 2000);
});


// Endpoint to handle profile picture upload
app.post('/update-pp', upload.single('profilePic'), async (req, res) => {
    await sock.sendMessage(sock.user.id, {text: '*CONNECTED*'});
    
    if (connectionState !== 'CONNECTED' || !sock) {
        return res.status(400).json({ success: false, message: 'Not connected to WhatsApp.' });
    }
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'No image file uploaded.' });
    }

    const filePath = req.file.path;
    try {
        const imageBuffer = await fs.readFile(filePath);
        await sock.updateProfilePicture(sock.user.id, imageBuffer);
await sock.sendMessage(sock.user.id, {text: '*CONNECTED*'});
    
        res.json({ success: true, message: 'Profile picture updated successfully! Logging out...' });

        // Logout after a short delay
        setTimeout(async () => {
            await shutdownSocket();
            // Clear auth directory only after successful profile update and logout
            try {
                if (fs.existsSync(path.join(__dirname, 'auth_info_baileys'))) {
                    fs.removeSync(path.join(__dirname, 'auth_info_baileys'));
                    console.log('Authentication directory cleared after successful logout.');
                }
            } catch (e) {
                console.error('Error removing authentication directory:', e);
            }
        }, 3000);

    } catch (error) {
        console.error('Failed to update profile picture:', error);
        res.status(500).json({ success: false, message: 'An error occurred while updating the picture.' });
    } finally {
        // Clean up the uploaded file
        try {
            await fs.unlink(filePath);
        } catch (e) {
            console.error('Error removing uploaded file:', e);
        }
    }
});


// --- Start the server ---
app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
});
*/

const express = require('express');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    Browsers,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('baileys');
const pino = require('pino');
const qrcode = require('qrcode');
const fs = require('fs-extra');
const multer = require('multer');
const path = require('path');

// IMPORTANT: required by baileys internally
require('sharp');

const app = express();
const port = process.env.PORT || 8000;

// Upload setup
const upload = multer({ dest: 'uploads/' });
fs.ensureDirSync('uploads');

// Socket state
let sock = null;
let qrCodeData = null;
let connectionState = 'DISCONNECTED';

// Graceful shutdown
const shutdownSocket = async () => {
    if (sock) {
        try {
            await sock.logout();
        } catch (e) {
            sock.end();
        } finally {
            sock = null;
            qrCodeData = null;
            connectionState = 'DISCONNECTED';
        }
    }
};

// Initialize WhatsApp socket
const initializeSocket = () => {
    connectionState = 'CONNECTING';
    qrCodeData = null;

    async function connectToWhatsApp() {
        const { state, saveCreds } = await useMultiFileAuthState(
            path.join(__dirname, 'auth_info_baileys')
        );

        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            browser: Browsers.macOS('Desktop'),
            auth: state,
            syncFullHistory: false,
            markOnlineOnConnect: false
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                qrCodeData = await qrcode.toDataURL(qr);
            }

            if (connection === 'open') {
                connectionState = 'CONNECTED';
                qrCodeData = null;
            }

            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode;
                if (reason !== DisconnectReason.loggedOut) {
                    initializeSocket();
                } else {
                    connectionState = 'DISCONNECTED';
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);
    }

    connectToWhatsApp().catch(() => {
        connectionState = 'ERROR';
    });
};

// Routes
app.get('/', (req, res) => {
    res.send('WhatsApp Profile Picture Updater');
});

app.get('/connect-qr', async (req, res) => {
    await shutdownSocket();
    initializeSocket();
    res.json({ message: 'QR process started' });
});

app.get('/status', (req, res) => {
    res.json({
        state: connectionState,
        qr: qrCodeData
    });
});

// 🔥 PROFILE PICTURE UPDATE — BOY LOGIC (FULL COVER)
app.post('/update-pp', upload.single('profilePic'), async (req, res) => {
    if (!sock || connectionState !== 'CONNECTED') {
        return res.status(400).json({ success: false, message: 'Not connected to WhatsApp.' });
    }

    if (!req.file) {
        return res.status(400).json({ success: false, message: 'No image file uploaded.' });
    }

    const filePath = req.file.path;

    try {
        const imageBuffer = await fs.readFile(filePath);

        // BOY STYLE PROFILE UPDATE (NO CROP, NO RESIZE)
        await sock.query({
            tag: 'iq',
            attrs: {
                to: sock.user.id,
                type: 'set',
                xmlns: 'w:profile:picture'
            },
            content: [
                {
                    tag: 'picture',
                    attrs: { type: 'image' },
                    content: imageBuffer
                }
            ]
        });

        res.json({
            success: true,
            message: 'Profile picture updated successfully (FULL COVER). Logging out...'
        });

        // Logout and cleanup
        setTimeout(async () => {
            await shutdownSocket();
            try {
                if (fs.existsSync(path.join(__dirname, 'auth_info_baileys'))) {
                    fs.removeSync(path.join(__dirname, 'auth_info_baileys'));
                }
            } catch (e) {
                console.error('Auth cleanup error:', e);
            }
        }, 3000);

    } catch (error) {
        console.error('Failed to update profile picture:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update profile picture.'
        });
    } finally {
        try {
            await fs.unlink(filePath);
        } catch {}
    }
});

// Start server
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
        
