const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}

app.use(cors({
    origin: ["https://pdf-coviewer.netlify.app", "http://localhost:3000"],
    credentials: true
}));

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        // Sanitize filename and ensure PDF extension
        const sanitizedName = file.fieldname.replace(/[^a-zA-Z0-9]/g, '-');
        cb(null, `${sanitizedName}-${Date.now()}.pdf`);
    }
});

// Add file filter to only allow PDFs
const fileFilter = (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
        cb(null, true);
    } else {
        cb(new Error('Only PDF files are allowed'), false);
    }
};

const upload = multer({ 
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB limit
    }
});

const io = new Server(server, {
    cors: {
        origin: ["https://pdf-coviewer.netlify.app", "http://localhost:3000"],
        methods: ["GET", "POST"],
        credentials: true
    }
});

app.use('/uploads', express.static(uploadsDir));

const sessions = {};

app.post('/upload', upload.single('pdf'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        const fileUrl = `/uploads/${req.file.filename}`;
        res.json({ fileUrl });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    socket.on('create-session', (pdfUrl) => {
        try {
            const sessionId = uuidv4();
            sessions[sessionId] = {
                admin: socket.id,
                viewers: new Set(), // Using Set to prevent duplicates
                currentPage: 1,
                pdfUrl: pdfUrl,
                createdAt: Date.now()
            };
            socket.join(sessionId);
            socket.emit('session-created', { sessionId });
            console.log(`Session created: ${sessionId}`);
        } catch (err) {
            console.error('Error creating session:', err);
            socket.emit('error', { message: 'Failed to create session' });
        }
    });

    socket.on('join-session', (sessionId) => {
        try {
            if (!sessions[sessionId]) {
                socket.emit('error', { message: 'Session not found' });
                return;
            }
            socket.join(sessionId);
            sessions[sessionId].viewers.add(socket.id);
            socket.emit('session-joined', {
                pdfUrl: sessions[sessionId].pdfUrl,
                currentPage: sessions[sessionId].currentPage
            });
            console.log(`Viewer joined session: ${sessionId}`);
        } catch (err) {
            console.error('Error joining session:', err);
            socket.emit('error', { message: 'Failed to join session' });
        }
    });

    socket.on('page-change', ({ sessionId, pageNumber }) => {
        try {
            console.log('Server received page change:', { sessionId, pageNumber });
            if (!sessions[sessionId]) {
                socket.emit('error', { message: 'Session not found' });
                return;
            }
            if (sessions[sessionId].admin !== socket.id) {
                socket.emit('error', { message: 'Unauthorized to change page' });
                return;
            }
            sessions[sessionId].currentPage = pageNumber;
            io.to(sessionId).emit('page-update', pageNumber);
            console.log(`Page changed in session ${sessionId} to ${pageNumber}`);
        } catch (err) {
            console.error('Error changing page:', err);
            socket.emit('error', { message: 'Failed to change page' });
        }
    });

    socket.on('disconnect', () => {
        try {
            console.log('User disconnected:', socket.id);
            for (const sessionId in sessions) {
                if (sessions[sessionId].admin === socket.id) {
                    // Clean up uploaded file
                    const pdfUrl = sessions[sessionId].pdfUrl;
                    const filePath = path.join(uploadsDir, path.basename(pdfUrl));
                    if (fs.existsSync(filePath)) {
                        fs.unlinkSync(filePath);
                    }
                    delete sessions[sessionId];
                } else {
                    sessions[sessionId].viewers.delete(socket.id);
                }
            }
        } catch (err) {
            console.error('Error handling disconnect:', err);
        }
    });
});

// Clean up old sessions periodically
setInterval(() => {
    const now = Date.now();
    for (const sessionId in sessions) {
        if (now - sessions[sessionId].createdAt > 24 * 60 * 60 * 1000) { // 24 hours
            delete sessions[sessionId];
        }
    }
}, 60 * 60 * 1000); // Check every hour

app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Something broke!' });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
