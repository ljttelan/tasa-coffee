# Tasa Coffee

A standalone PHP and MySQL storefront based on the supplied Tasa Coffee mockup. It supports a product catalog, search and categories, a session cart, customer accounts and order history, stock-aware checkout, and role-based staff tools.

## Requirements

- PHP 8.0+ with PDO and `pdo_mysql`
- MySQL 5.7+ or MariaDB 10.3+
- Apache/Nginx configured to serve this directory over HTTPS in production

## Local setup (XAMPP)

1. Place this project folder in your web root (for example, `C:\xampp\htdocs\TasaCoffee`).
2. In phpMyAdmin, create and select a database named `tasa_coffee`, then import `schema.sql` from this folder.
3. Configure the database connection. By default, the app uses `127.0.0.1`, database `tasa_coffee`, user `root`, and an empty password. For another setup, define `TASA_DB_HOST`, `TASA_DB_NAME`, `TASA_DB_USER`, and `TASA_DB_PASS` in the PHP/Apache environment. Create and select the database before importing the schema.
4. Create the first admin account from a command prompt:

   ```powershell
   cd C:\xampp\htdocs\TasaCoffee
   C:\xampp\php\php.exe create-admin.php "Shop Admin" admin@example.com "use-a-long-unique-password"
   ```

5. Open `http://localhost/TasaCoffee/`.

The admin can add products, archive products, review returns, and assign staff roles. New signups are customer accounts. Staff can manage orders; fulfillment accounts can update non-terminal order statuses.

## Deployment

Create a MySQL database in your hosting control panel, upload this folder to a PHP host, and import `schema.sql` into that database. Set the four `TASA_DB_*` environment variables in the host's PHP configuration. Run `create-admin.php` from the host's CLI; do not make admin creation a public web page. Serve the app over HTTPS and use a unique database password. Checkout and card/GCash options are demo-only and do not process real payments.

The database schema seeds the sample products once when imported into a new database. Re-importing the file will add the sample rows again.
