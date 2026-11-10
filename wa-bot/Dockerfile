# Dockerfile — bot WhatsApp (Go, whatsmeow) untuk Coolify/VPS.
#
# Multi-stage: build dengan Go tanpa CGO (modernc.org/sqlite pure-Go),
# lalu image runtime kecil berisi binary + tzdata (untuk waktu Indonesia).
FROM golang:1.26-alpine AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -o /out/wa-bot .

FROM alpine:3
RUN apk add --no-cache ca-certificates tzdata
COPY --from=build /out/wa-bot /usr/local/bin/wa-bot

WORKDIR /data
ENTRYPOINT ["/usr/local/bin/wa-bot"]
