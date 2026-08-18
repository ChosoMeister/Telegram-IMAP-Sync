# همگام‌ساز Telegram و IMAP

یک صندوق کار تک‌کاربره و self-hosted است که Inbox ایمیل Exchange را در ربات خصوصی Telegram نمایش می‌دهد. ایمیل تا زمان Done، Reply یا Forward در صف می‌ماند؛ سپس فقط بعد از موفقیت مراحل SMTP/Sent/Archive، کارت و فایل‌های مرتبط از چت پاک می‌شوند.

## قابلیت‌های اصلی

- ورود همه ایمیل‌های Inbox و همگام‌سازی افزایشی بدون دانلود دوباره MIMEهای قدیمی
- تحلیل اهمیت، خلاصه و اقدام پیشنهادی با ترتیب قابل تنظیم Ollama و پراکسی سازمانی؛ خرابی AI دریافت ایمیل را متوقف نمی‌کند
- سیاست ثابت نگارش فارسی اداری: استفاده از «با درود و مهر» و «با سپاس» و اصلاح قطعی خروجی اگر مدل از عبارت‌های ممنوع استفاده کند
- نمایش متن کامل HTML/plain با صفحه‌بندی روی همان کارت و دکمه بازگشت
- دریافت پیوست واقعی هنگام درخواست و حذف تصاویر inline امضا از فهرست پیوست‌ها
- جداسازی چندمرحله‌ای فایل اصلی از CID، لوگو، آیکون و تصاویر امضا؛ موارد مخفی‌شده با دکمه جدا قابل بررسی‌اند
- Done امن، Reply، Reply All و Forward با پیش‌نمایش و تأیید نهایی
- ثبت دقیق نسخه ارسالی در پوشه Sent تنظیم‌شده و جلوگیری از ارسال تکراری پس از خطا
- پرسش آزاد از AI درباره ایمیل، PDF/DOCX/فایل متنی قابل استخراج یا کل مکالمه
- بازیابی Thread از Inbox، Archive و Sent و استفاده از آن در خلاصه و پیش‌نویس Reply
- قفل اتمیک عملیات، migration نسخه‌دار و صف پایدار تحلیل AI
- حذف خودکار کارت ایمیلی که خارج از ربات از Inbox منتقل شده است، پس از دو بار تأیید
- reconnect خودکار IMAP، health endpoint، backup آنلاین SQLite و Docker چندسکویی

## شروع امن

```sh
cp .env.example .env
docker compose config --quiet
docker compose build --pull
docker compose up -d
docker compose logs -f --tail 100
```

در PowerShell به‌جای دستور اول از `Copy-Item .env.example .env` استفاده کنید. ابتدا `APP_MODE=dry-run` و `TEST_IMPORT_LIMIT=1` بماند. با `npm run discover` نام دقیق Archive و Sent را پیدا و با `npm run preflight` اتصال‌ها را بررسی کنید. بعد از تست یک ایمیل کنترل‌شده، `APP_MODE=live` و برای تولید `TEST_IMPORT_LIMIT=0` قرار دهید.

هیچ‌وقت `.env`، توکن Telegram، رمز ایمیل، کلید AI یا قواعد واقعی سازمان را commit نکنید. `docker compose down` داده را نگه می‌دارد؛ از `--volumes` در عملیات عادی استفاده نکنید.

## مستندات

- [مرجع کامل تنظیمات](docs/CONFIGURATION.md)
- [راه‌اندازی، backup/restore، ارتقا و عیب‌یابی](docs/OPERATIONS.md)
- [قواعد محلی ایمیل](docs/MAIL_RULES.md)
- [مشخصات محصول](docs/SPEC.md) و [معماری](docs/ARCHITECTURE.md)
- [چک‌لیست نگهداری مستندات و انتشار](docs/MAINTENANCE.md)

وضعیت سرویس روی `http://127.0.0.1:18080/` است و هنگام قطع IMAP کد `503` می‌دهد. پاسخ health وضعیت IMAP، Telegram، SMTP، AI، backup و صف کارها را نشان می‌دهد. دستور `/status` داخل ربات نیز خلاصه وضعیت را نمایش می‌دهد. تصویرهای `amd64` و `arm64` با tagهای `latest`، نسخه `0.3.1` و commit در `ghcr.io/chosomeister/telegram-imap-sync` منتشر می‌شوند؛ Compose مخزن عمداً سورس checkoutشده را build می‌کند.
