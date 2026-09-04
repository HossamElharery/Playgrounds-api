const corsOptions = {
  origin: '*', // Replace '*' with specific origins in production for security
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'], // Allow all HTTP methods
  allowedHeaders: '*', // Allow all headers dynamically
  exposedHeaders: '*', // Expose all headers dynamically
  credentials: true, // Enable this if you handle cookies or authentication
};

export default corsOptions;
