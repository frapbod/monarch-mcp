SHELL := /bin/bash

.PHONY: build test typecheck lint format format-check check image clean

build:
	npm run build

test:
	npm test

typecheck:
	npm run typecheck

lint:
	npm run lint

format:
	npm run format

format-check:
	npm run format:check

check: format-check lint typecheck test build

image:
	@set -a; source ./versions.env; set +a; \
	docker build --build-arg NODE_VERSION="$${NODE_VERSION}" -t monarch-mcp:dev .

clean:
	rm -rf dist coverage
