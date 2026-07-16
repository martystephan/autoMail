FROM node:22-alpine

# Prisma's Alpine engine needs OpenSSL at runtime. Keep the build toolchain for
# any transitive native dependencies installed by npm.
RUN apk add --no-cache openssl python3 make g++

WORKDIR /app

# Install dependencies (including dev for ts-node)
COPY package*.json ./
RUN npm ci

# Copy source
COPY . .

# npm ci runs before the Prisma schema is copied, so generate the client now.
RUN npx prisma generate

# Create data directory for SQLite
RUN mkdir -p /app/data

EXPOSE 4000

CMD ["npm", "start"]
