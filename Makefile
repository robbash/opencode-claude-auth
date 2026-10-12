.PHONY: build bundle install-local test test-models lint fix format clean intercept intercept-all intercept-update validate-oauth validate-oauth-dry

build:
	pnpm run build

bundle:  ## Single-file ESM bundle for drop-in plugin install (dist/plugin.js)
	pnpm run build:bundle

install-local: ## Bundle and copy into ~/.config/opencode/plugins/
	pnpm run install:local

test:
	pnpm test

test-models:
	pnpm run test:models

lint:
	pnpm run lint

fix:
	pnpm run lint:fix

format:
	pnpm run format

clean:
	rm -rf dist

intercept:
	pnpm run intercept

intercept-all:
	pnpm run intercept:all

intercept-update:
	pnpm run intercept:update

validate-oauth: build  ## Run live OAuth refresh (rotates token, writes back)
	pnpm run validate:oauth

validate-oauth-dry: build  ## Dry-run OAuth refresh (no network request)
	pnpm run validate:oauth -- --dry-run

all: lint build test
