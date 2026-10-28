# Windows'ta hazır yerel paket

Paket Windows 10/11 x64 ve ARM64 içindir. Node.js 24.19.0, üretim
bağımlılıkları ve derlenmiş uygulama pakettedir; kullanıcı bilgisayarına Git,
Node.js, Docker veya ek bir veritabanı kurulmaz. Yönetici yetkisi gerekmez.

1. ZIP dosyasını **Tümünü ayıkla** ile bir klasöre çıkarın.
2. **Baslat.cmd** dosyasını açın. Personel ekranı tarayıcıda açılır.
3. İlk giriş bilgileri yalnız bilgisayarınızdaki Windows bilgi penceresinde
   gösterilir. Yeniden görmek için **Giris-Bilgileri.cmd** dosyasını açın.

İsterseniz **Masaustune-Ekle.cmd** dosyasına çift tıklayarak masaüstü kısayolu
oluşturun. Kısayol paketi çıkarttığınız mevcut klasöre bağlıdır. Bu klasörü
sonradan taşımayın; taşır veya yeni bir klasörden kullanmaya başlarsanız
**Masaustune-Ekle.cmd** dosyasını yeni konumunda yeniden çalıştırın.

Parola ilk çalıştırmada rastgele oluşturulur; pakette sabit parola yoktur.
Kayıt, Windows DPAPI `CurrentUser` ile şifrelenir. Sohbete, komut satırı
argümanlarına veya düz metin dosyasına parola yazılmaz. Var olan personel
hesabının parolası yeniden başlatmada değiştirilmez.

Siparişler ve dosyalar `%LOCALAPPDATA%\Dijital360\PrintShop\database` içinde
kalır. Bunlar Railway verilerinden bağımsız yerel kayıtlardır. Paketi başka
bir klasöre çıkarmak bu veri klasörünü değiştirmez. Güncellemeden önce açık
uygulama penceresinde **Ctrl+C** ile durdurun, sonra yeni paketi başlatın.
Aynı anda yeniden başlatma mevcut çalışan uygulamanın tarayıcısını açar.

## Yerel yedek alma

1. Uygulamanın açık komut penceresinde **Ctrl+C** ile durdurun ve kapanmasını
   bekleyin.
2. **Yedek-Al.cmd** dosyasına çift tıklayın. Veritabanı hâlâ kullanılıyorsa
   işlem reddedilir; önce çalışan uygulamayı kapatın.
3. Yedek `%USERPROFILE%\Dijital360-Yedekler` klasörüne yazılır. Veritabanı ve
   DPAPI ile şifrelenmiş kişisel giriş kaydı birlikte saklanır.

Yedekleri özel tutun. Giriş kaydı yalnız aynı bilgisayar ve aynı Windows
kullanıcısıyla çözülebilir; farklı bilgisayar veya Windows kullanıcısına geri
yükleme bu pakette sunulmaz.

Uygulama yalnız `127.0.0.1` üzerinde çalışır; başlangıç portu doluysa boş bir
port seçilir. PowerShell yürütme politikası, güvenlik duvarı veya TLS
doğrulaması değiştirilmez. Node çalıştırılmadan önce resmi çalışma dosyasının
SHA-256 değeri; uygulama açılırken de paketin dosya sağlama toplamları denetlenir.

## Paket oluşturma

Temiz, commit edilmiş kaynak ve iki mimari için resmi SHA-256 manifestiyle
doğrulanmış Node Windows çalışma dosyaları gerekir. Paketleyici, kaynağı
`git archive HEAD` ile alır, canlı sürümü derler ve kilit dosyasından yalnız
üretim bağımlılıklarını kurar. Gerçek `.env`, `.npmrc`, özel veritabanı,
Git metadata'sı, sembolik bağlantı veya platforma özgü bağımlılık pakete alınmaz.

```sh
node scripts/package-windows.mjs \
  --runtime-dir /tmp/print-shop-windows-runtime \
  --output /workspace/artifacts/Dijital360-PrintShop-Windows.zip \
  --owner-email owner@example.com
```

Hazırlama ortamında Node/npm, Git, tar ve Python 3 kullanılır. ZIP yanında
SHA-256 dosyası üretilir; Node lisansları, uygulama kaynak kodu ve bağımlılık
lisansları korunur. Windows'a özgü DPAPI, GUI ve CMD başlatma adımları gerçek
Windows bilgisayarında doğrulanmalıdır; Linux testleri bu kontrollerin yerine
geçmez.
