"""Убирает приставку «Вак_» у преподавателей в базе журнала.

«Вак_Иванов Иван Иванович» и «Иванов Иван Иванович» – один человек: запись с
приставкой сливается в запись без неё (связи, отметки, занятия переносятся).
Если приставка стоит перед одной фамилией («Вак_Иванов»), двойник ищется среди
преподавателей с этой фамилией; при нескольких кандидатах выбирается тот, у кого
совпадает дисциплина. Когда двойника нет, приставка просто снимается.
Без --apply ничего не пишет, только отчёт. Повторный запуск ничего не меняет.

python3 scripts/merge_vak.py data/attendance.sqlite --apply
Сервер на время записи остановить: реестр он читает при запуске.
"""
import argparse, sqlite3

PREFIX = "Вак_"


def plan(db):
    teachers = {r[0]: r[1] for r in db.execute("SELECT id, name FROM roster_teachers")}
    by_name = {}
    for tid, name in teachers.items():
        by_name.setdefault(name, []).append(tid)
    courses = {}
    for tid, course in db.execute(
        "SELECT teacherId, course FROM roster_enrollments UNION "
        "SELECT teacherId, json_extract(data, '$.course') FROM lessons"
    ):
        courses.setdefault(tid, set()).add(course)
    merges, renames, unresolved = [], [], []
    for tid, name in sorted(teachers.items(), key=lambda t: t[1]):
        if not name.startswith(PREFIX):
            continue
        plain = name[len(PREFIX):]
        exact = [t for t in by_name.get(plain, []) if t != tid]
        if exact:
            merges.append((tid, name, exact[0], plain))
            continue
        if " " not in plain:  # только фамилия: ищем по фамилии
            found = [
                t for t, n in teachers.items()
                if t != tid and not n.startswith(PREFIX) and n.split(" ")[0] == plain
            ]
            if len(found) > 1:
                found = [t for t in found if courses.get(t, set()) & courses.get(tid, set())]
            if len(found) == 1:
                merges.append((tid, name, found[0], teachers[found[0]]))
                continue
            if len(found) > 1:
                unresolved.append((name, [teachers[t] for t in found]))
                continue
        renames.append((tid, name, plain))
    return merges, renames, unresolved


def merge(db, vak, target):
    db.execute("UPDATE roster_enrollments SET teacherId=? WHERE teacherId=?", (target, vak))
    db.execute(
        "DELETE FROM roster_enrollments WHERE rowid NOT IN (SELECT min(rowid) "
        "FROM roster_enrollments GROUP BY studentId, teacherId, grp, course, kind)"
    )
    db.execute("UPDATE lessons SET teacherId=? WHERE teacherId=?", (target, vak))
    for table in ("daily_marks", "daily_revisions"):
        db.execute(f"UPDATE OR IGNORE {table} SET teacherId=? WHERE teacherId=?", (target, vak))
        db.execute(f"DELETE FROM {table} WHERE teacherId=?", (vak,))
    for table in ("teacher_links", "auto_accounts"):
        db.execute(f"UPDATE OR IGNORE {table} SET teacherId=? WHERE teacherId=?", (target, vak))
        db.execute(f"DELETE FROM {table} WHERE teacherId=?", (vak,))
    db.execute("DELETE FROM roster_teachers WHERE id=?", (vak,))


def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("database")
    p.add_argument("--apply", action="store_true", help="записать изменения")
    args = p.parse_args()
    db = sqlite3.connect(args.database)
    merges, renames, unresolved = plan(db)
    print(f"Слияние с двойником ({len(merges)}):")
    for _, name, _, target in merges:
        print(f"  {name} → {target}")
    print(f"Снятие приставки ({len(renames)}):")
    for _, name, plain in renames:
        print(f"  {name} → {plain}")
    if unresolved:
        print(f"Не решено, несколько кандидатов ({len(unresolved)}):")
        for name, found in unresolved:
            print(f"  {name}: {', '.join(found)}")
    if not args.apply:
        print("Сухой прогон: ничего не записано. Для записи добавьте --apply.")
        return
    with db:
        for vak, _, target, _ in merges:
            merge(db, vak, target)
        for tid, _, plain in renames:
            db.execute("UPDATE roster_teachers SET name=? WHERE id=?", (plain, tid))
    left = db.execute("SELECT count(*) FROM roster_teachers WHERE name LIKE ?", (PREFIX + "%",)).fetchone()[0]
    total = db.execute("SELECT count(*) FROM roster_teachers").fetchone()[0]
    print(f"Записано. Преподавателей: {total}, с приставкой осталось: {left}.")


if __name__ == "__main__":
    main()
