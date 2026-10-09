require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const connectDB = require('./config/db');
const errorHandler = require('./middleware/errorHandler');

// Route imports
const authRoutes = require('./routes/auth');
const departmentRoutes = require('./routes/departments');
const jobRoutes = require('./routes/jobs');
const applicationRoutes = require('./routes/applications');
const dashboardRoutes = require('./routes/dashboard');
const userRoutes = require('./routes/users');
const webhookRoutes = require('./routes/webhooks');
const notificationRoutes = require('./routes/notifications');
const mailRoutes = require('./routes/mail');
const { startReminderScheduler } = require('./utils/adminAlerts');

const app = express();
const PORT = process.env.PORT || 5000;

// Connect to MongoDB
connectDB();

// Allowed origins (comma-separated in env)
const allowedOrigins = (process.env.CLIENT_URL || 'http://localhost:3000')
  .split(',')
  .map((url) => url.trim());

// Middleware
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, server-to-server)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    // Lets the admin app read download file names (resume, CSV export).
    exposedHeaders: ['Content-Disposition'],
  })
);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Serve locally-stored uploads when R2 is not configured
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/departments', departmentRoutes);
app.use('/api/jobs', jobRoutes);
app.use('/api/applications', applicationRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/users', userRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/mail', mailRoutes);

// Error handler (must be after routes)
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  // Admin reminders (unreviewed applications, interviews, job deadlines, follow-ups).
  if (process.env.DISABLE_REMINDERS !== 'true') startReminderScheduler();
});
