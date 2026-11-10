# Dockerfile — REST API e-TA (Node) untuk Coolify/VPS.
#
# Dibangun dari context root repo. Tidak butuh CGO ataupun dependensi native,
# jadi image Alpine ringan sudah cukup.
FROM node:22-alpine

WORKDIR /app

# Copy dependency manifests dulu agar layer cache efektif.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3001

CMD ["node", "server.js"]
