const errorHandler = (err, req, res, next) => {
  console.error(err);

  // Multer file size error
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ message: 'File size exceeds the 5MB limit' });
  }

  // Multer file type error
  if (err.message && err.message.includes('Only PDF, DOC, and DOCX')) {
    return res.status(400).json({ message: err.message });
  }

  // S3/R2 access errors
  if (err.name === 'AccessDenied' || err.Code === 'AccessDenied') {
    return res.status(500).json({ message: 'File storage service is temporarily unavailable. Please try again later.' });
  }

  // Mongoose validation error
  if (err.name === 'ValidationError') {
    const messages = Object.values(err.errors).map((e) => e.message);
    return res.status(400).json({ message: messages.join(', ') });
  }

  // Mongoose duplicate key error
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue)[0];
    return res.status(400).json({ message: `A record with that ${field} already exists` });
  }

  // Mongoose bad ObjectId
  if (err.name === 'CastError' && err.kind === 'ObjectId') {
    return res.status(400).json({ message: 'Invalid ID format' });
  }

  const statusCode = err.statusCode || 500;
  const response = {
    message: err.message || 'Internal server error',
  };

  if (process.env.NODE_ENV !== 'production') {
    response.stack = err.stack;
  }

  res.status(statusCode).json(response);
};

module.exports = errorHandler;
