# Use Node.js LTS
FROM node:18-slim

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy app source
COPY . .

# Cloud Run sets PORT environment variable
ENV PORT=8080

# Start the service
CMD ["node", "index.js"]
