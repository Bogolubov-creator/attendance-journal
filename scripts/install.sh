#!/usr/bin/env bash
# Прежняя команда установки на Linux: теперь это обёртка над общим установщиком
# (install.sh в корне). --docker / --native – этот компьютер через Docker / без него.
exec "$(dirname "$0")/../install.sh" "$@"
