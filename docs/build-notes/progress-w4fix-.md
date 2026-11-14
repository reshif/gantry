# w4fix- progress (wave-3 review follow-ups)
PG: docker run -d --name w4fix-pg -e POSTGRES_PASSWORD=pw -p 55492:5432 --tmpfs /var/lib/postgresql/data mirror.gcr.io/library/postgres:17-alpine -c fsync=off -c max_connections=300
Tests: GANTRY_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55492/postgres npm test -w @gantry/api
Items 1-7 per task. Status below.
