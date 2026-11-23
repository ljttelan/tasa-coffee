<?php
declare(strict_types=1);

require_once __DIR__ . '/config.php';

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

if ($argc !== 4) {
    fwrite(STDERR, "Usage: php create-admin.php \"Name\" email@example.com \"password\"\n");
    exit(1);
}

[$script, $name, $email, $password] = $argv;
$email = strtolower(trim($email));
if (!filter_var($email, FILTER_VALIDATE_EMAIL) || strlen($email) > 190 || strlen($password) < 12 || strlen($password) > 72) {
    fwrite(STDERR, "Use a valid email address and a password between 12 and 72 characters.\n");
    exit(1);
}

$db = tasa_db();
$stmt = $db->prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)');
$stmt->execute([$name, $email, password_hash($password, PASSWORD_DEFAULT), 'admin']);
fwrite(STDOUT, "Administrator account created for $email.\n");
