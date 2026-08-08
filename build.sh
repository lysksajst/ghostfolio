#!/bin/bash
docker compose -f docker/docker-compose.yml build
docker save -o ~/ghostfolio+cnh.tar ghostfolio/ghostfolio:local
