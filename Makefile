SHELL := /bin/bash

.PHONY: build test test-race typecheck lint format format-check generate check image clean

build:
	npm run build

test:
	npm test

# JavaScript has no race detector. Running the suite concurrently catches shared
# singleton and authentication-state mistakes that are the relevant analogue.
test-race:
	npm run test:race

typecheck:
	npm run typecheck

lint:
	npm run lint

format:
	npm run format

format-check:
	npm run format:check

generate:
	@true

check: format-check lint typecheck test test-race build

image:
	@set -a; source ./versions.env; set +a; \
	docker build --build-arg NODE_VERSION="$${NODE_VERSION}" -t monarch-mcp:dev .

clean:
	rm -rf dist coverage
