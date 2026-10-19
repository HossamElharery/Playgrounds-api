# Matchena local production database backups

## عربي — أول نسخة احتياطية، خطوة بخطوة

هذا السكربت ينشئ نسخة PostgreSQL مشفّرة وقابلة للاسترجاع على جهاز الـMac، بدون أي تكلفة. لا يحفظ رابط قاعدة البيانات أو كلمة مرور التشفير في Git أو Coolify أو سجل الأوامر.

1. افتح [Coolify](https://coolify.matchena.com/)، ثم مشروع **Matchena** ← بيئة **production** ← قاعدة **matchena-postgres**، وانسخ رابط الاتصال `DATABASE_URL`. لا ترسله في رسالة ولا تحفظه في ملف.
2. افتح تطبيق **Terminal** على جهازك.
3. نفّذ الأمر التالي للانتقال إلى مشروع الـAPI:

   ```bash
   cd "/Users/hossamelharery/Documents/Playgrounds/back-end/matchena-api"
   ```

4. نفّذ هذه الأوامر كما هي. بعد أول أمر سيطلب منك الـTerminal لصق `DATABASE_URL`؛ ألصقه ثم اضغط Enter. لن يظهر النص أثناء اللصق، وهذا مقصود للحماية.

   ```bash
   read -s 'MATCHENA_DATABASE_URL?Production DATABASE_URL: '; export MATCHENA_DATABASE_URL
   ./scripts/backup-production-db-local.sh
   unset MATCHENA_DATABASE_URL
   ```

5. عندما يطلب منك السكربت كلمة مرور للتشفير، اكتب كلمة قوية وفريدة واحفظها في Password Manager. لن تظهر أثناء الكتابة، ولن يتم حفظها في الملف.
6. عند ظهور `Backup created:` تكون العملية انتهت. ستجد الملف المشفّر في:

   ```text
   ~/Documents/Matchena Backups/
   ```

الملف امتداده `.dump.enc` ولا يمكن قراءته دون كلمة المرور. جهازك يحتوي بالفعل على `pg_dump`، لذلك لا توجد خطوة تثبيت إضافية.

## عربي — جدول مقترح

- نفّذ نسخة احتياطية مرة أسبوعيًا.
- احتفظ بآخر 4 نسخ على الأقل.
- انسخ الملفات المشفّرة إلى قرص خارجي بعد كل نسخة. وجود النسخة الوحيدة على نفس اللابتوب ليس حماية من فقدان أو تلف اللابتوب.
- لا تسترجع على قاعدة الإنتاج كاختبار.

## English — first backup, step by step

This script creates an encrypted, restorable PostgreSQL backup on the Mac at no cost. It never stores the database URL or encryption passphrase in Git, Coolify, or shell history.

1. In [Coolify](https://coolify.matchena.com/), open **Matchena** → **production** → **matchena-postgres**, and copy `DATABASE_URL`. Do not save or share it.
2. Open **Terminal** and run:

   ```bash
   cd "/Users/hossamelharery/Documents/Playgrounds/back-end/matchena-api"
   read -s 'MATCHENA_DATABASE_URL?Production DATABASE_URL: '; export MATCHENA_DATABASE_URL
   ./scripts/backup-production-db-local.sh
   unset MATCHENA_DATABASE_URL
   ```

3. Paste the database URL only when prompted; the input is intentionally hidden. Choose a strong unique encryption passphrase when asked and keep it in a password manager.
4. The encrypted `.dump.enc` file is saved in `~/Documents/Matchena Backups/`.

## Restore drill / اختبار الاسترجاع

Use a new local database or a temporary server database—never overwrite production during a test.

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
  -in "$HOME/Documents/Matchena Backups/matchena-postgres-YYYY-MM-DD_HH-MM-SS.dump.enc" \
  -out /tmp/matchena-restore.dump
pg_restore --clean --if-exists --no-owner --dbname "postgresql://LOCAL_TEST_CONNECTION" /tmp/matchena-restore.dump
rm -f /tmp/matchena-restore.dump
```
