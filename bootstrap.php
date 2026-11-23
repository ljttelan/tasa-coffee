<?php
declare(strict_types=1);

require_once __DIR__ . '/config.php';

if (session_status() !== PHP_SESSION_ACTIVE) {
    session_set_cookie_params([
        'httponly' => true,
        'secure' => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
        'samesite' => 'Lax',
    ]);
    session_start();
}

function h($value): string
{
    return htmlspecialchars((string) $value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function csrf_field(): string
{
    if (empty($_SESSION['csrf_token'])) {
        $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
    }
    return '<input type="hidden" name="csrf_token" value="' . h($_SESSION['csrf_token']) . '">';
}

function verify_csrf(): void
{
    $token = (string) ($_POST['csrf_token'] ?? '');
    if ($token === '' || !hash_equals((string) ($_SESSION['csrf_token'] ?? ''), $token)) {
        http_response_code(400);
        exit('The form expired. Go back, reload the page, and try again.');
    }
}

function current_user(): ?array
{
    if (empty($_SESSION['tasa_user']['id'])) {
        return null;
    }

    static $loaded = false;
    static $user = null;
    if (!$loaded) {
        $loaded = true;
        $stmt = tasa_db()->prepare('SELECT id, name, email, role FROM users WHERE id = ?');
        $stmt->execute([(int) $_SESSION['tasa_user']['id']]);
        $user = $stmt->fetch() ?: null;
        if ($user) {
            $_SESSION['tasa_user'] = $user;
        } else {
            unset($_SESSION['tasa_user']);
        }
    }

    return $user;
}

function require_login(): array
{
    $user = current_user();
    if (!$user) {
        redirect('index.php?page=account');
    }
    return $user;
}

function require_staff(): array
{
    $user = require_login();
    if (!in_array($user['role'], ['admin', 'staff', 'fulfillment'], true)) {
        http_response_code(403);
        exit('You do not have permission to access this page.');
    }
    return $user;
}

function redirect(string $url): void
{
    header('Location: ' . $url, true, 303);
    exit;
}

function flash(string $message, string $kind = 'success'): void
{
    $_SESSION['tasa_flash'] = ['message' => $message, 'kind' => $kind];
}

function money($amount): string
{
    return '₱' . number_format((float) $amount, 2);
}

function cart_count(): int
{
    return array_sum(array_map('intval', $_SESSION['tasa_cart'] ?? []));
}

function product_options(string $category): array
{
    if ($category === 'Beans') {
        return ['Whole bean', 'Espresso grind', 'Filter grind'];
    }
    if ($category === 'Brewed') {
        return ['Regular', 'Large (+₱30)'];
    }
    return ['Standard'];
}

function option_price(array $product, string $option): float
{
    return (float) $product['price'] + ($option === 'Large (+₱30)' ? 30 : 0);
}

function delivery_fee(float $subtotal): float
{
    return $subtotal === 0.0 || $subtotal >= 1000 ? 0.0 : 60.0;
}

function cart_details(PDO $db): array
{
    $cart = $_SESSION['tasa_cart'] ?? [];
    if (!$cart) {
        return ['items' => [], 'subtotal' => 0.0, 'fee' => 0.0, 'total' => 0.0];
    }

    $ids = array_values(array_unique(array_map('intval', array_keys($cart))));
    $placeholders = implode(',', array_fill(0, count($ids), '?'));
    $stmt = $db->prepare("SELECT id, name, category, price, stock, image_url FROM products WHERE active = 1 AND id IN ($placeholders)");
    $stmt->execute($ids);
    $products = [];
    foreach ($stmt->fetchAll() as $product) {
        $products[(int) $product['id']] = $product;
    }

    $items = [];
    $subtotal = 0.0;
    foreach ($cart as $key => $quantity) {
        [$id, $option] = array_pad(explode(':', (string) $key, 2), 2, 'Standard');
        $id = (int) $id;
        if (!isset($products[$id])) {
            continue;
        }
        $product = $products[$id];
        $quantity = max(1, (int) $quantity);
        $unitPrice = option_price($product, $option);
        $subtotal += $unitPrice * $quantity;
        $items[] = [
            'product' => $product,
            'option' => $option,
            'quantity' => $quantity,
            'unit_price' => $unitPrice,
            'key' => $key,
        ];
    }

    $fee = delivery_fee($subtotal);
    return ['items' => $items, 'subtotal' => $subtotal, 'fee' => $fee, 'total' => $subtotal + $fee];
}
