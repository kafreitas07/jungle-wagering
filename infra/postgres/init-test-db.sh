#!/bin/sh
# Runs once, on first initialization of the data volume.
# Integration and concurrency suites use wagering_test, never the development database.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-SQL
	CREATE DATABASE wagering_test OWNER "$POSTGRES_USER";
SQL
