ENV_FILE ?= ./envs/.env
# 기본 envs/.env 는 없을 수 있다 (dev/prod 타깃이 각자 ENV_FILE 을 지정한다).
# 없는 파일을 include 하면 make 가 파싱 단계에서 바로 실패하므로 -include 를 쓴다.
-include $(ENV_FILE)
export

.PHONY: dev prod up pull-up down network check-env clean

COMPOSE_FILE ?= ci/docker-composes/docker-compose.dev.yaml

# dev 환경: .env.dev 사용
dev:
	@$(MAKE) up ENV_FILE=./envs/.env.dev COMPOSE_FILE=ci/docker-composes/docker-compose.dev.yaml

# prod 환경: .env.prod 사용
# 운영 이미지는 VM 에서 빌드하지 않고 GHCR 에서 pull 한다 (.github/workflows 참고).
# .env.prod 에 IMAGE_PREFIX=ghcr.io/<owner>/<repo> 가 있어야 하며, 비공개 패키지면
# 먼저 `docker login ghcr.io` 가 필요하다. 롤백은 IMAGE_TAG=<커밋 SHA> 로 지정.
# 외부 트래픽/TLS 는 서버 공용 엣지 프록시(ci/edge/ 참고)가 담당합니다.
prod:
	@$(MAKE) pull-up ENV_FILE=./envs/.env.prod COMPOSE_FILE=ci/docker-composes/docker-compose.prod.yaml

# env 파일이 없으면 변수가 모두 비어 compose 가 엉뚱하게 실행되므로 먼저 막는다.
check-env:
	@test -f $(ENV_FILE) || { echo "❌ $(ENV_FILE) 이 없습니다. envs/.env.example 을 복사해 만드세요."; exit 1; }
	@test -n "$(PROJECT_NAME)" || { echo "❌ $(ENV_FILE) 에 PROJECT_NAME 이 없습니다."; exit 1; }

# 네트워크 생성 및 실행
network: check-env
	@docker network inspect $(NETWORK_NAME) >/dev/null 2>&1 || \
	docker network create $(NETWORK_NAME)
	@docker network inspect $(if $(EDGE_NETWORK_NAME),$(EDGE_NETWORK_NAME),edge) >/dev/null 2>&1 || \
	docker network create $(if $(EDGE_NETWORK_NAME),$(EDGE_NETWORK_NAME),edge)
up: network
	docker compose -p $(PROJECT_NAME) --env-file $(ENV_FILE) -f $(COMPOSE_FILE) up -d --build
# 이미지를 pull 한 뒤 바뀐 서비스만 교체하고 healthcheck 통과까지 대기
pull-up: network
	docker compose -p $(PROJECT_NAME) --env-file $(ENV_FILE) -f $(COMPOSE_FILE) pull --quiet
	docker compose -p $(PROJECT_NAME) --env-file $(ENV_FILE) -f $(COMPOSE_FILE) up -d --no-build --wait --remove-orphans
# 모든 컨테이너 종료 (볼륨은 보존 — DB 데이터·SSL 인증서 유지)
down:
	@$(MAKE) down-env ENV_FILE=./envs/.env.dev COMPOSE_FILE=ci/docker-composes/docker-compose.dev.yaml
	@$(MAKE) down-env ENV_FILE=./envs/.env.prod COMPOSE_FILE=ci/docker-composes/docker-compose.prod.yaml
down-env:
	docker compose -p $(PROJECT_NAME) --env-file $(ENV_FILE) -f $(COMPOSE_FILE) down

# 모든 컨테이너 종료 + 볼륨 완전 삭제 (DB 데이터 포함)
# SSL 인증서는 엣지 프록시(ci/edge/)의 볼륨에 있으므로 영향받지 않습니다.
clean:
	@$(MAKE) clean-env ENV_FILE=./envs/.env.dev COMPOSE_FILE=ci/docker-composes/docker-compose.dev.yaml
	@$(MAKE) clean-env ENV_FILE=./envs/.env.prod COMPOSE_FILE=ci/docker-composes/docker-compose.prod.yaml
clean-env:
	docker compose -p $(PROJECT_NAME) --env-file $(ENV_FILE) -f $(COMPOSE_FILE) down -v