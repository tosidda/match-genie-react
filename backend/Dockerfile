# Build the one-shot YouTube proof-of-origin token generator once.  The local
# backend downloads authorized YouTube sources before handing them to AWS, so
# it needs the same player-challenge runtime as the Batch worker.
FROM node:22-bookworm-slim AS pot-provider
ARG BGUTIL_POT_VERSION=1.3.1
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /opt
RUN git clone --depth 1 --branch "${BGUTIL_POT_VERSION}" \
    https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git && \
    cd bgutil-ytdlp-pot-provider/server && \
    npm ci && \
    npx tsc

FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg libgl1 libglib2.0-0 && \
    rm -rf /var/lib/apt/lists/*

COPY --from=pot-provider /usr/local/bin/node /usr/local/bin/node
COPY --from=pot-provider /opt/bgutil-ytdlp-pot-provider/server /opt/bgutil/server

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 5000

# A full-resolution match can take well over 15 minutes to copy from the local
# upload volume into S3 on a residential connection.  The /video/analyze route
# must be allowed to finish that durable cloud handoff before Gunicorn recycles
# its worker; AWS Batch takes over immediately afterward.
# Load the application and run additive SQLite schema initialization once in
# the Gunicorn master before forking workers. Without preload, four workers can
# race to CREATE a newly introduced table during the first production boot.
CMD ["gunicorn", "--preload", "-b", "0.0.0.0:5000", "-w", "4", "--timeout", "7200", "app:create_app()"]
