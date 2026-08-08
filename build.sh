#!/bin/bash
docker compose -f docker/docker-compose.yml build
docker export ghostfolio/ghostfolio:local > ~/ghostfolio+cnh.tar
