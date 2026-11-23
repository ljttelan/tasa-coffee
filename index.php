<?php
declare(strict_types=1);

require_once __DIR__ . '/bootstrap.php';

try {
    $db = tasa_db();
} catch (PDOException $exception) {
    error_log('Tasa Coffee database connection error: ' . $exception->getMessage());
    http_response_code(500);
    exit('Tasa Coffee could not connect to its database. Check the database settings and import tasa/schema.sql.');
}
$categories = ['Beans', 'Brewed', 'Pastries', 'Merch'];
$statuses = ['Pending', 'Packing', 'Out for delivery', 'Delivered', 'Cancelled', 'Returned'];
$error = '';

function admin_only(): array
{
    $user = require_staff();
    if ($user['role'] !== 'admin') {
        http_response_code(403);
        exit('Only an administrator can manage products or staff accounts.');
    }
    return $user;
}

function order_items(PDO $db, int $orderId): array
{
    $stmt = $db->prepare('SELECT product_name, product_option, quantity, unit_price FROM order_items WHERE order_id = ? ORDER BY id');
    $stmt->execute([$orderId]);
    return $stmt->fetchAll();
}

function order_row(PDO $db, int $orderId, ?int $userId = null): ?array
{
    $sql = 'SELECT * FROM orders WHERE id = ?';
    $params = [$orderId];
    if ($userId !== null) {
        $sql .= ' AND user_id = ?';
        $params[] = $userId;
    }
    $stmt = $db->prepare($sql);
    $stmt->execute($params);
    $order = $stmt->fetch();
    if ($order) {
        $order['items'] = order_items($db, $orderId);
    }
    return $order ?: null;
}

function restock_order(PDO $db, int $orderId): void
{
    $stmt = $db->prepare('SELECT product_id, quantity FROM order_items WHERE order_id = ? AND product_id IS NOT NULL FOR UPDATE');
    $stmt->execute([$orderId]);
    $update = $db->prepare('UPDATE products SET stock = stock + ? WHERE id = ?');
    foreach ($stmt->fetchAll() as $item) {
        $update->execute([(int) $item['quantity'], (int) $item['product_id']]);
    }
}

function order_code(int $id): string
{
    return 'T' . (1000 + $id);
}

function staff_link(string $tab): string
{
    return 'index.php?page=staff&tab=' . rawurlencode($tab);
}

function next_order_statuses(string $status): array
{
    $transitions = [
        'Pending' => ['Packing', 'Cancelled'],
        'Packing' => ['Out for delivery', 'Cancelled'],
        'Out for delivery' => ['Delivered', 'Cancelled'],
        'Delivered' => [],
        'Cancelled' => [],
        'Returned' => [],
    ];
    return $transitions[$status] ?? [];
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    verify_csrf();
    $action = (string) ($_POST['action'] ?? '');

    try {
        if ($action === 'register') {
            $name = trim((string) ($_POST['name'] ?? ''));
            $email = strtolower(trim((string) ($_POST['email'] ?? '')));
            $password = (string) ($_POST['password'] ?? '');
            if ($name === '' || strlen($name) > 120 || !filter_var($email, FILTER_VALIDATE_EMAIL)
                || strlen($email) > 190 || strlen($password) < 8 || strlen($password) > 72) {
                throw new InvalidArgumentException('Enter a name, valid email, and password between 8 and 72 characters.');
            }
            $stmt = $db->prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)');
            $stmt->execute([$name, $email, password_hash($password, PASSWORD_DEFAULT)]);
            session_regenerate_id(true);
            $_SESSION['tasa_user'] = ['id' => (int) $db->lastInsertId(), 'name' => $name, 'email' => $email, 'role' => 'customer'];
            flash('Your account is ready.');
            redirect('index.php?page=account');
        }

        if ($action === 'login') {
            $email = strtolower(trim((string) ($_POST['email'] ?? '')));
            $stmt = $db->prepare('SELECT id, name, email, password_hash, role FROM users WHERE email = ?');
            $stmt->execute([$email]);
            $user = $stmt->fetch();
            $password = (string) ($_POST['password'] ?? '');
            if (!$user || strlen($password) > 72 || !password_verify($password, $user['password_hash'])) {
                throw new InvalidArgumentException('Email or password is incorrect.');
            }
            session_regenerate_id(true);
            unset($user['password_hash']);
            $_SESSION['tasa_user'] = $user;
            flash('Welcome back, ' . $user['name'] . '.');
            redirect($user['role'] === 'customer' ? 'index.php?page=account' : 'index.php?page=staff');
        }

        if ($action === 'logout') {
            $_SESSION = [];
            session_regenerate_id(true);
            flash('You are signed out.');
            redirect('index.php');
        }

        if ($action === 'cart_add') {
            $id = filter_input(INPUT_POST, 'product_id', FILTER_VALIDATE_INT);
            $stmt = $db->prepare('SELECT id, category, stock FROM products WHERE id = ? AND active = 1');
            $stmt->execute([(int) $id]);
            $product = $stmt->fetch();
            if (!$product) {
                throw new InvalidArgumentException('That product is no longer available.');
            }
            $option = (string) ($_POST['option'] ?? 'Standard');
            if (!in_array($option, product_options($product['category']), true)) {
                throw new InvalidArgumentException('Choose a valid product option.');
            }
            $key = (int) $product['id'] . ':' . $option;
            $cart = $_SESSION['tasa_cart'] ?? [];
            $inCart = 0;
            foreach ($cart as $cartKey => $quantity) {
                if (str_starts_with((string) $cartKey, (int) $product['id'] . ':')) {
                    $inCart += (int) $quantity;
                }
            }
            if ($inCart >= (int) $product['stock']) {
                throw new InvalidArgumentException('No more stock is available for that product.');
            }
            $cart[$key] = (int) ($cart[$key] ?? 0) + 1;
            $_SESSION['tasa_cart'] = $cart;
            flash('Added to your cart.');
            redirect('index.php');
        }

        if ($action === 'cart_update') {
            $key = (string) ($_POST['key'] ?? '');
            $quantity = filter_var($_POST['quantity'] ?? null, FILTER_VALIDATE_INT);
            if (!isset($_SESSION['tasa_cart'][$key])) {
                throw new InvalidArgumentException('That cart item is no longer available.');
            }
            if ($quantity === false || $quantity < 1) {
                unset($_SESSION['tasa_cart'][$key]);
            } else {
                $id = (int) strstr($key, ':', true);
                $stmt = $db->prepare('SELECT stock FROM products WHERE id = ? AND active = 1');
                $stmt->execute([$id]);
                $stock = $stmt->fetchColumn();
                if ($stock === false || $quantity > (int) $stock) {
                    throw new InvalidArgumentException('The requested quantity exceeds available stock.');
                }
                $_SESSION['tasa_cart'][$key] = $quantity;
            }
            redirect('index.php?page=cart');
        }

        if ($action === 'checkout') {
            $user = require_login();
            $name = trim((string) ($_POST['name'] ?? ''));
            $phone = trim((string) ($_POST['phone'] ?? ''));
            $billing = trim((string) ($_POST['billing_address'] ?? ''));
            $shipping = trim((string) ($_POST['shipping_address'] ?? ''));
            $payment = (string) ($_POST['payment_method'] ?? '');
            if ($name === '' || strlen($name) > 120 || $phone === '' || strlen($phone) > 50
                || $billing === '' || strlen($billing) > 500 || $shipping === '' || strlen($shipping) > 500
                || !in_array($payment, ['GCash (mock)', 'Card (mock)', 'Cash on delivery'], true)) {
                throw new InvalidArgumentException('Complete all checkout fields and select a valid payment method.');
            }

            $cart = $_SESSION['tasa_cart'] ?? [];
            if (!$cart) {
                throw new InvalidArgumentException('Your cart is empty.');
            }
            $db->beginTransaction();
            $items = [];
            $subtotal = 0.0;
            foreach ($cart as $key => $quantity) {
                [$id, $option] = array_pad(explode(':', (string) $key, 2), 2, 'Standard');
                $stmt = $db->prepare('SELECT id, name, category, price, stock FROM products WHERE id = ? AND active = 1 FOR UPDATE');
                $stmt->execute([(int) $id]);
                $product = $stmt->fetch();
                $quantity = (int) $quantity;
                if (!$product || $quantity < 1 || $quantity > (int) $product['stock']
                    || !in_array($option, product_options($product['category'] ?? ''), true)) {
                    throw new InvalidArgumentException('A cart item is unavailable or has insufficient stock. Review your cart.');
                }
                $unitPrice = option_price($product, $option);
                $subtotal += $unitPrice * $quantity;
                $items[] = ['product' => $product, 'option' => $option, 'quantity' => $quantity, 'unit_price' => $unitPrice];
            }
            $fee = delivery_fee($subtotal);
            $stmt = $db->prepare('INSERT INTO orders (user_id, customer_name, phone, billing_address, shipping_address, payment_method, subtotal, delivery_fee, total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
            $stmt->execute([$user['id'], $name, $phone, $billing, $shipping, $payment, $subtotal, $fee, $subtotal + $fee]);
            $orderId = (int) $db->lastInsertId();
            $insertItem = $db->prepare('INSERT INTO order_items (order_id, product_id, product_name, product_option, quantity, unit_price) VALUES (?, ?, ?, ?, ?, ?)');
            $reduceStock = $db->prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?');
            foreach ($items as $item) {
                $product = $item['product'];
                $insertItem->execute([$orderId, $product['id'], $product['name'], $item['option'], $item['quantity'], $item['unit_price']]);
                $reduceStock->execute([$item['quantity'], $product['id'], $item['quantity']]);
                if ($reduceStock->rowCount() !== 1) {
                    throw new InvalidArgumentException('Stock changed while you were checking out. Please try again.');
                }
            }
            $db->commit();
            unset($_SESSION['tasa_cart']);
            flash('Order ' . order_code($orderId) . ' placed. Payment is not processed by this demo.');
            redirect('index.php?page=account');
        }

        if ($action === 'cancel_order') {
            $user = require_login();
            $db->beginTransaction();
            $stmt = $db->prepare('SELECT id, status FROM orders WHERE id = ? AND user_id = ? FOR UPDATE');
            $stmt->execute([(int) ($_POST['order_id'] ?? 0), $user['id']]);
            $order = $stmt->fetch();
            if (!$order || !in_array($order['status'], ['Pending', 'Packing'], true)) {
                throw new InvalidArgumentException('Only pending or packing orders can be cancelled.');
            }
            restock_order($db, (int) $order['id']);
            $db->prepare("UPDATE orders SET status = 'Cancelled' WHERE id = ?")->execute([$order['id']]);
            $db->commit();
            flash('Your order has been cancelled.');
            redirect('index.php?page=account');
        }

        if ($action === 'request_return') {
            $user = require_login();
            $stmt = $db->prepare("UPDATE orders SET return_status = 'Requested' WHERE id = ? AND user_id = ? AND status = 'Delivered' AND return_status = 'None'");
            $stmt->execute([(int) ($_POST['order_id'] ?? 0), $user['id']]);
            if ($stmt->rowCount() !== 1) {
                throw new InvalidArgumentException('Only delivered orders without an existing return request can be returned.');
            }
            flash('Your return request was sent to the shop.');
            redirect('index.php?page=account');
        }

        if ($action === 'save_product') {
            admin_only();
            $id = filter_var($_POST['product_id'] ?? null, FILTER_VALIDATE_INT);
            $name = trim((string) ($_POST['name'] ?? ''));
            $category = (string) ($_POST['category'] ?? '');
            $description = trim((string) ($_POST['description'] ?? ''));
            $price = filter_var($_POST['price'] ?? null, FILTER_VALIDATE_FLOAT);
            $stock = filter_var($_POST['stock'] ?? null, FILTER_VALIDATE_INT);
            $imageUrl = trim((string) ($_POST['image_url'] ?? ''));
            if ($name === '' || strlen($name) > 160 || !in_array($category, $categories, true)
                || $price === false || $price < 0 || $stock === false || $stock < 0
                || ($imageUrl !== '' && (!filter_var($imageUrl, FILTER_VALIDATE_URL) || !in_array(parse_url($imageUrl, PHP_URL_SCHEME), ['http', 'https'], true)))) {
                throw new InvalidArgumentException('Check the product name, category, price, stock, and optional image URL.');
            }
            if ($id) {
                $stmt = $db->prepare('UPDATE products SET name = ?, category = ?, description = ?, price = ?, stock = ?, image_url = ? WHERE id = ?');
                $stmt->execute([$name, $category, $description, $price, $stock, $imageUrl ?: null, $id]);
            } else {
                $stmt = $db->prepare('INSERT INTO products (name, category, description, price, stock, image_url) VALUES (?, ?, ?, ?, ?, ?)');
                $stmt->execute([$name, $category, $description, $price, $stock, $imageUrl ?: null]);
            }
            flash('Product saved.');
            redirect(staff_link('Inventory'));
        }

        if ($action === 'toggle_product') {
            admin_only();
            $stmt = $db->prepare('UPDATE products SET active = 1 - active WHERE id = ?');
            $stmt->execute([(int) ($_POST['product_id'] ?? 0)]);
            flash('Product visibility updated.');
            redirect(staff_link('Inventory'));
        }

        if ($action === 'update_order') {
            $user = require_staff();
            $id = (int) ($_POST['order_id'] ?? 0);
            $newStatus = (string) ($_POST['status'] ?? '');
            if (!in_array($newStatus, $statuses, true) || ($user['role'] === 'fulfillment' && in_array($newStatus, ['Cancelled', 'Returned'], true))) {
                throw new InvalidArgumentException('That order status is not available to your account.');
            }
            $db->beginTransaction();
            $stmt = $db->prepare('SELECT status FROM orders WHERE id = ? FOR UPDATE');
            $stmt->execute([$id]);
            $oldStatus = $stmt->fetchColumn();
            if ($oldStatus === false || ($newStatus !== $oldStatus && !in_array($newStatus, next_order_statuses($oldStatus), true))
                || ($user['role'] === 'fulfillment' && $newStatus === 'Cancelled')) {
                throw new InvalidArgumentException('That order status transition is not allowed.');
            }
            if ($newStatus === 'Cancelled' && $oldStatus !== 'Cancelled') {
                restock_order($db, $id);
            }
            $db->prepare('UPDATE orders SET status = ? WHERE id = ?')->execute([$newStatus, $id]);
            $db->commit();
            flash('Order status updated.');
            redirect(staff_link('Orders'));
        }

        if ($action === 'review_return') {
            admin_only();
            $id = (int) ($_POST['order_id'] ?? 0);
            $decision = (string) ($_POST['decision'] ?? '');
            if (!in_array($decision, ['Approved', 'Rejected'], true)) {
                throw new InvalidArgumentException('Choose an approval decision.');
            }
            $db->beginTransaction();
            $stmt = $db->prepare('SELECT status, return_status FROM orders WHERE id = ? FOR UPDATE');
            $stmt->execute([$id]);
            $order = $stmt->fetch();
            if (!$order || $order['status'] !== 'Delivered' || $order['return_status'] !== 'Requested') {
                throw new InvalidArgumentException('That return request is no longer awaiting review.');
            }
            if ($decision === 'Approved') {
                restock_order($db, $id);
                $db->prepare("UPDATE orders SET status = 'Returned', return_status = 'Approved' WHERE id = ?")->execute([$id]);
            } else {
                $db->prepare("UPDATE orders SET return_status = 'Rejected' WHERE id = ?")->execute([$id]);
            }
            $db->commit();
            flash('Return request ' . strtolower($decision) . '.');
            redirect(staff_link('Orders'));
        }

        if ($action === 'update_role') {
            admin_only();
            $userId = (int) ($_POST['user_id'] ?? 0);
            $role = (string) ($_POST['role'] ?? '');
            if ($userId === (int) current_user()['id'] || !in_array($role, ['customer', 'fulfillment', 'staff', 'admin'], true)) {
                throw new InvalidArgumentException('You cannot change your own role or assign that role.');
            }
            $db->prepare('UPDATE users SET role = ? WHERE id = ?')->execute([$role, $userId]);
            flash('Account role updated.');
            redirect(staff_link('Customers'));
        }
    } catch (InvalidArgumentException $exception) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        $error = $exception->getMessage();
    } catch (PDOException $exception) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        if ($action === 'register' && $exception->getCode() === '23000') {
            $error = 'That email address already has an account.';
        } else {
            error_log('Tasa Coffee database error: ' . $exception->getMessage());
            http_response_code(500);
            $error = 'The request could not be completed due to a database error. Check the server log for details.';
        }
    }
}

$page = (string) ($_GET['page'] ?? 'shop');
$user = current_user();
$notice = $_SESSION['tasa_flash'] ?? null;
unset($_SESSION['tasa_flash']);
$search = trim((string) ($_GET['q'] ?? ''));
$categoryFilter = (string) ($_GET['category'] ?? 'All');
$sort = (string) ($_GET['sort'] ?? 'name');
$productStmt = $db->prepare("SELECT * FROM products WHERE active = 1 AND stock > 0 AND (? = '' OR category = ?) AND (? = '' OR name LIKE ? OR description LIKE ?) ORDER BY " . ($sort === 'price_low' ? 'price ASC, name ASC' : ($sort === 'price_high' ? 'price DESC, name ASC' : 'name ASC')));
$term = '%' . $search . '%';
$productStmt->execute([$categoryFilter === 'All' ? '' : $categoryFilter, $categoryFilter, $search, $term, $term]);
$products = $productStmt->fetchAll();

$pageTitle = 'Tasa Coffee — Fresh from the roaster';
?>
<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#4b3a7a">
    <title><?php echo h($pageTitle); ?></title>
    <link rel="stylesheet" href="styles.css">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@400;500;600;700;800&display=swap" rel="stylesheet">
</head>
<body>
<header class="site-header">
    <a class="brand" href="index.php"><span class="brand-mark" aria-hidden="true">☕</span><span>Tasa<small>Coffee, made local</small></span></a>
    <nav aria-label="Main navigation">
        <a href="index.php">Shop</a>
        <a href="index.php?page=cart">Cart <span class="cart-count"><?php echo cart_count(); ?></span></a>
        <?php if ($user && $user['role'] !== 'customer'): ?><a href="index.php?page=staff">Staff</a><?php endif; ?>
        <?php if ($user): ?>
            <a href="index.php?page=account">Account</a>
            <form method="post" class="nav-form"><?php echo csrf_field(); ?><input type="hidden" name="action" value="logout"><button class="nav-link" type="submit">Sign out</button></form>
        <?php else: ?>
            <a href="index.php?page=account">Log in</a>
        <?php endif; ?>
    </nav>
</header>
<main class="container">
    <?php if ($notice): ?><div class="notice <?php echo h($notice['kind']); ?>" role="status"><?php echo h($notice['message']); ?></div><?php endif; ?>
    <?php if ($error !== ''): ?><div class="notice error" role="alert"><?php echo h($error); ?></div><?php endif; ?>

    <?php if ($page === 'shop'): ?>
        <section class="hero">
            <div class="hero-copy"><span class="eyebrow">GOOD COFFEE. GOOD COMPANY.</span><h1>Fresh from the roaster</h1><p>Filipino beans, comforting brews, and treats for the moments in between.</p><a class="button" href="#products">Shop the menu</a></div>
            <div class="hero-art" aria-hidden="true"><span>☕</span><b>Made with<br>mahal.</b></div>
        </section>
        <section id="products" class="section">
            <div class="section-heading"><div><span class="eyebrow">THE TASA MENU</span><h2>Find your new favorite</h2></div><p class="muted">Free delivery on orders over ₱1,000</p></div>
            <form class="filters" method="get" action="index.php#products">
                <input type="search" name="q" value="<?php echo h($search); ?>" placeholder="Search coffee, pastries, gear" aria-label="Search products">
                <select name="category" aria-label="Filter by category">
                    <?php foreach (array_merge(['All'], $categories) as $category): ?><option value="<?php echo h($category); ?>" <?php echo $categoryFilter === $category ? 'selected' : ''; ?>><?php echo h($category); ?></option><?php endforeach; ?>
                </select>
                <select name="sort" aria-label="Sort products">
                    <option value="name" <?php echo $sort === 'name' ? 'selected' : ''; ?>>Name</option>
                    <option value="price_low" <?php echo $sort === 'price_low' ? 'selected' : ''; ?>>Price: low to high</option>
                    <option value="price_high" <?php echo $sort === 'price_high' ? 'selected' : ''; ?>>Price: high to low</option>
                </select>
                <button class="button" type="submit">Find products</button>
            </form>
            <div class="product-grid">
                <?php foreach ($products as $product): ?>
                    <article class="product-card">
                        <?php if ($product['image_url']): ?><img class="product-image" src="<?php echo h($product['image_url']); ?>" alt="" loading="lazy"><?php else: ?><div class="product-image product-placeholder" aria-hidden="true"><?php echo $product['category'] === 'Pastries' ? '🥐' : ($product['category'] === 'Beans' ? '🫘' : ($product['category'] === 'Merch' ? '🥤' : '☕')); ?></div><?php endif; ?>
                        <span class="product-category"><?php echo h($product['category']); ?></span><h3><?php echo h($product['name']); ?></h3><p class="muted"><?php echo h($product['description']); ?></p>
                        <form class="add-form" method="post">
                            <?php echo csrf_field(); ?><input type="hidden" name="action" value="cart_add"><input type="hidden" name="product_id" value="<?php echo (int) $product['id']; ?>">
                            <?php if (count(product_options($product['category'])) > 1): ?><label class="sr-only" for="option-<?php echo (int) $product['id']; ?>">Choose an option for <?php echo h($product['name']); ?></label><select name="option" id="option-<?php echo (int) $product['id']; ?>"><?php foreach (product_options($product['category']) as $option): ?><option><?php echo h($option); ?></option><?php endforeach; ?></select><?php else: ?><input type="hidden" name="option" value="Standard"><?php endif; ?>
                            <div class="product-buy"><strong><?php echo money($product['price']); ?></strong><button class="button" type="submit">Add to cart</button></div>
                        </form>
                    </article>
                <?php endforeach; ?>
                <?php if (!$products): ?><p class="empty-state">No products match your search. Try another category or keyword.</p><?php endif; ?>
            </div>
        </section>

    <?php elseif ($page === 'cart'): ?>
        <?php $cartData = cart_details($db); ?>
        <section class="section narrow"><span class="eyebrow">YOUR ORDER</span><h1>Your cart</h1>
            <?php if (!$cartData['items']): ?><p class="muted">Your cart is empty.</p><a class="button" href="index.php">Browse the menu</a>
            <?php else: ?>
                <?php foreach ($cartData['items'] as $item): ?><div class="cart-row"><div><strong><?php echo h($item['product']['name']); ?></strong><p class="muted"><?php echo h($item['option']); ?> · <?php echo money($item['unit_price']); ?> each</p></div><form method="post" class="quantity-form"><?php echo csrf_field(); ?><input type="hidden" name="action" value="cart_update"><input type="hidden" name="key" value="<?php echo h($item['key']); ?>"><label class="sr-only" for="qty-<?php echo h(md5($item['key'])); ?>">Quantity</label><input id="qty-<?php echo h(md5($item['key'])); ?>" type="number" name="quantity" min="0" max="<?php echo (int) $item['product']['stock']; ?>" value="<?php echo (int) $item['quantity']; ?>"><button class="button secondary" type="submit">Update</button></form><strong><?php echo money($item['unit_price'] * $item['quantity']); ?></strong></div><?php endforeach; ?>
                <div class="totals"><div><span>Subtotal</span><b><?php echo money($cartData['subtotal']); ?></b></div><div><span>Delivery</span><b><?php echo $cartData['fee'] ? money($cartData['fee']) : 'Free'; ?></b></div><div class="total"><span>Total</span><b><?php echo money($cartData['total']); ?></b></div><a class="button full" href="index.php?page=checkout">Continue to checkout</a></div>
            <?php endif; ?>
        </section>

    <?php elseif ($page === 'checkout'): ?>
        <?php $user = require_login(); $cartData = cart_details($db); ?>
        <section class="section narrow"><span class="eyebrow">ALMOST THERE</span><h1>Checkout</h1>
            <?php if (!$cartData['items']): ?><p class="muted">Your cart is empty.</p><a class="button" href="index.php">Browse the menu</a>
            <?php else: ?><form method="post" class="form-card"><?php echo csrf_field(); ?><input type="hidden" name="action" value="checkout">
                <label>Full name<input name="name" required maxlength="120" value="<?php echo h($user['name']); ?>"></label>
                <label>Phone<input name="phone" required maxlength="50"></label>
                <label>Billing address<input name="billing_address" required maxlength="500"></label>
                <label>Shipping address<input name="shipping_address" required maxlength="500"></label>
                <label>Payment method<select name="payment_method"><option>GCash (mock)</option><option>Card (mock)</option><option>Cash on delivery</option></select></label>
                <p class="muted">Demo checkout only. No real payment is processed.</p>
                <div class="totals"><div><span>Total to pay</span><b><?php echo money($cartData['total']); ?></b></div><button class="button full" type="submit">Place order</button></div>
            </form><?php endif; ?>
        </section>

    <?php elseif ($page === 'account'): ?>
        <?php if (!$user): ?>
            <section class="section narrow"><span class="eyebrow">WELCOME TO TASA</span><h1>Your account</h1><div class="auth-grid">
                <form method="post" class="form-card"><?php echo csrf_field(); ?><input type="hidden" name="action" value="login"><h2>Log in</h2><label>Email<input name="email" type="email" autocomplete="email" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button class="button full" type="submit">Log in</button></form>
                <form method="post" class="form-card"><?php echo csrf_field(); ?><input type="hidden" name="action" value="register"><h2>Create account</h2><label>Name<input name="name" autocomplete="name" maxlength="120" required></label><label>Email<input name="email" type="email" autocomplete="email" maxlength="190" required></label><label>Password (8-72 characters)<input name="password" type="password" autocomplete="new-password" minlength="8" maxlength="72" required></label><button class="button full" type="submit">Create account</button></form>
            </div></section>
        <?php else: ?>
            <?php $stmt = $db->prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC, id DESC'); $stmt->execute([$user['id']]); $orders = $stmt->fetchAll(); ?>
            <section class="section narrow"><span class="eyebrow">YOUR TASA ACCOUNT</span><h1>Hi, <?php echo h($user['name']); ?></h1><h2>Your orders</h2>
                <?php foreach ($orders as $order): ?><article class="order-card"><div class="order-heading"><strong><?php echo h(order_code((int) $order['id'])); ?></strong><span class="status"><?php echo h($order['status']); ?></span></div><p class="muted"><?php echo h($order['created_at']); ?> · <?php echo money($order['total']); ?></p><p><?php foreach (order_items($db, (int) $order['id']) as $item): ?><?php echo (int) $item['quantity']; ?> × <?php echo h($item['product_name']); ?> (<?php echo h($item['product_option']); ?>)<?php endforeach; ?></p>
                    <?php if (in_array($order['status'], ['Pending', 'Packing'], true)): ?><form method="post" class="inline-form"><?php echo csrf_field(); ?><input type="hidden" name="action" value="cancel_order"><input type="hidden" name="order_id" value="<?php echo (int) $order['id']; ?>"><button class="text-button" type="submit">Cancel order</button></form><?php endif; ?>
                    <?php if ($order['status'] === 'Delivered' && $order['return_status'] === 'None'): ?><form method="post" class="inline-form"><?php echo csrf_field(); ?><input type="hidden" name="action" value="request_return"><input type="hidden" name="order_id" value="<?php echo (int) $order['id']; ?>"><button class="text-button" type="submit">Request return</button></form><?php elseif ($order['return_status'] !== 'None'): ?><p class="muted">Return: <?php echo h($order['return_status']); ?></p><?php endif; ?>
                </article><?php endforeach; ?>
                <?php if (!$orders): ?><p class="muted">No orders yet. Your first order will appear here.</p><a class="button" href="index.php">Shop the menu</a><?php endif; ?>
            </section>
        <?php endif; ?>

    <?php elseif ($page === 'staff'): ?>
        <?php
        $staff = require_staff();
        $tabs = $staff['role'] === 'admin' ? ['Orders', 'Inventory', 'Customers', 'Reports'] : ($staff['role'] === 'staff' ? ['Orders', 'Customers', 'Reports'] : ['Orders']);
        $tab = (string) ($_GET['tab'] ?? 'Orders');
        if (!in_array($tab, $tabs, true)) { $tab = 'Orders'; }
        ?>
        <section class="section"><span class="eyebrow">TASA OPERATIONS</span><h1>Staff dashboard</h1><div class="tabs"><?php foreach ($tabs as $tabName): ?><a class="tab <?php echo $tab === $tabName ? 'active' : ''; ?>" href="<?php echo h(staff_link($tabName)); ?>"><?php echo h($tabName); ?></a><?php endforeach; ?></div>
            <?php if ($tab === 'Orders'): ?>
                <?php $orders = $db->query('SELECT o.*, u.email FROM orders o JOIN users u ON u.id = o.user_id ORDER BY o.created_at DESC, o.id DESC')->fetchAll(); ?>
                <div class="stack"><?php foreach ($orders as $order): ?><article class="order-card"><div class="order-heading"><strong><?php echo h(order_code((int) $order['id'])); ?> · <?php echo h($order['customer_name']); ?></strong><span class="status"><?php echo h($order['status']); ?></span></div><p class="muted"><?php echo h($order['email']); ?> · <?php echo h($order['phone']); ?> · <?php echo h($order['shipping_address']); ?> · <?php echo h($order['payment_method']); ?> · <?php echo money($order['total']); ?></p><p><?php foreach (order_items($db, (int) $order['id']) as $item): ?><?php echo (int) $item['quantity']; ?> × <?php echo h($item['product_name']); ?> (<?php echo h($item['product_option']); ?>)<?php endforeach; ?></p>
                    <?php if (next_order_statuses($order['status'])): ?><form method="post" class="inline-form"><?php echo csrf_field(); ?><input type="hidden" name="action" value="update_order"><input type="hidden" name="order_id" value="<?php echo (int) $order['id']; ?>"><label class="sr-only" for="status-<?php echo (int) $order['id']; ?>">Order status</label><select id="status-<?php echo (int) $order['id']; ?>" name="status"><option selected><?php echo h($order['status']); ?></option><?php foreach (next_order_statuses($order['status']) as $status): if ($staff['role'] === 'fulfillment' && $status === 'Cancelled') { continue; } ?><option><?php echo h($status); ?></option><?php endforeach; ?></select><button class="button secondary" type="submit">Update status</button></form><?php endif; ?>
                    <?php if ($order['return_status'] === 'Requested' && $staff['role'] === 'admin'): ?><div class="inline-actions"><span class="status">Return requested</span><?php foreach (['Approved', 'Rejected'] as $decision): ?><form method="post" class="inline-form"><?php echo csrf_field(); ?><input type="hidden" name="action" value="review_return"><input type="hidden" name="order_id" value="<?php echo (int) $order['id']; ?>"><input type="hidden" name="decision" value="<?php echo h($decision); ?>"><button class="button <?php echo $decision === 'Rejected' ? 'secondary' : ''; ?>" type="submit"><?php echo h($decision); ?> return</button></form><?php endforeach; ?></div><?php elseif ($order['return_status'] !== 'None'): ?><p class="muted">Return: <?php echo h($order['return_status']); ?></p><?php endif; ?>
                </article><?php endforeach; ?><?php if (!$orders): ?><p class="muted">No orders yet.</p><?php endif; ?></div>
            <?php elseif ($tab === 'Inventory' && $staff['role'] === 'admin'): ?>
                <?php $edit = isset($_GET['edit']) ? (int) $_GET['edit'] : 0; $productEdit = null; if ($edit) { $stmt = $db->prepare('SELECT * FROM products WHERE id = ?'); $stmt->execute([$edit]); $productEdit = $stmt->fetch() ?: null; } ?>
                <form method="post" class="form-card inventory-form"><?php echo csrf_field(); ?><input type="hidden" name="action" value="save_product"><input type="hidden" name="product_id" value="<?php echo (int) ($productEdit['id'] ?? 0); ?>"><h2><?php echo $productEdit ? 'Edit product' : 'Add product'; ?></h2><label>Name<input name="name" maxlength="160" required value="<?php echo h($productEdit['name'] ?? ''); ?>"></label><label>Category<select name="category"><?php foreach ($categories as $category): ?><option <?php echo ($productEdit['category'] ?? 'Beans') === $category ? 'selected' : ''; ?>><?php echo h($category); ?></option><?php endforeach; ?></select></label><label>Description<input name="description" value="<?php echo h($productEdit['description'] ?? ''); ?>"></label><label>Price (₱)<input type="number" name="price" min="0" step="0.01" required value="<?php echo h($productEdit['price'] ?? ''); ?>"></label><label>Stock<input type="number" name="stock" min="0" step="1" required value="<?php echo h($productEdit['stock'] ?? ''); ?>"></label><label>Image URL (optional)<input type="url" name="image_url" placeholder="https://…" value="<?php echo h($productEdit['image_url'] ?? ''); ?>"></label><button class="button" type="submit"><?php echo $productEdit ? 'Save changes' : 'Add product'; ?></button></form>
                <div class="table-wrap"><table><thead><tr><th>Product</th><th>Category</th><th>Price</th><th>Stock</th><th>Visibility</th><th>Actions</th></tr></thead><tbody><?php foreach ($db->query('SELECT * FROM products ORDER BY name')->fetchAll() as $product): ?><tr><td><?php echo h($product['name']); ?></td><td><?php echo h($product['category']); ?></td><td><?php echo money($product['price']); ?></td><td><?php echo (int) $product['stock']; ?></td><td><?php echo $product['active'] ? 'Active' : 'Archived'; ?></td><td class="table-actions"><a class="text-button" href="<?php echo h(staff_link('Inventory')); ?>&amp;edit=<?php echo (int) $product['id']; ?>">Edit</a><form method="post"><?php echo csrf_field(); ?><input type="hidden" name="action" value="toggle_product"><input type="hidden" name="product_id" value="<?php echo (int) $product['id']; ?>"><button class="text-button" type="submit"><?php echo $product['active'] ? 'Archive' : 'Restore'; ?></button></form></td></tr><?php endforeach; ?></tbody></table></div>
            <?php elseif ($tab === 'Customers'): ?>
                <?php $customers = $db->query('SELECT u.id, u.name, u.email, u.role, COUNT(o.id) AS order_count FROM users u LEFT JOIN orders o ON o.user_id = u.id GROUP BY u.id ORDER BY u.created_at DESC')->fetchAll(); ?>
                <div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Orders</th><th>Role</th></tr></thead><tbody><?php foreach ($customers as $customer): ?><tr><td><?php echo h($customer['name']); ?></td><td><?php echo h($customer['email']); ?></td><td><?php echo (int) $customer['order_count']; ?></td><td><?php if ($staff['role'] === 'admin' && (int) $customer['id'] !== (int) $staff['id']): ?><form method="post" class="inline-form"><?php echo csrf_field(); ?><input type="hidden" name="action" value="update_role"><input type="hidden" name="user_id" value="<?php echo (int) $customer['id']; ?>"><select name="role" aria-label="Role for <?php echo h($customer['email']); ?>"><?php foreach (['customer', 'fulfillment', 'staff', 'admin'] as $role): ?><option <?php echo $customer['role'] === $role ? 'selected' : ''; ?>><?php echo h($role); ?></option><?php endforeach; ?></select><button class="text-button" type="submit">Save</button></form><?php else: ?><?php echo h($customer['role']); ?><?php endif; ?></td></tr><?php endforeach; ?></tbody></table></div>
            <?php elseif ($tab === 'Reports'): ?>
                <?php $report = $db->query("SELECT COUNT(*) AS order_count, COALESCE(SUM(CASE WHEN status NOT IN ('Cancelled', 'Returned') THEN total ELSE 0 END), 0) AS revenue FROM orders")->fetch(); $top = $db->query("SELECT product_name, SUM(quantity) AS sold FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status NOT IN ('Cancelled', 'Returned') GROUP BY product_name ORDER BY sold DESC LIMIT 5")->fetchAll(); $low = $db->query('SELECT name, stock FROM products WHERE active = 1 AND stock < 10 ORDER BY stock, name')->fetchAll(); ?>
                <div class="stats"><article class="stat-card"><span class="muted">Revenue*</span><strong><?php echo money($report['revenue']); ?></strong></article><article class="stat-card"><span class="muted">Orders</span><strong><?php echo (int) $report['order_count']; ?></strong></article></div><p class="muted">*Excludes cancelled and returned orders.</p><h2>Top products</h2><?php foreach ($top as $item): ?><div class="list-row"><span><?php echo h($item['product_name']); ?></span><strong><?php echo (int) $item['sold']; ?> sold</strong></div><?php endforeach; ?><?php if (!$top): ?><p class="muted">No sales yet.</p><?php endif; ?><h2>Low stock</h2><?php foreach ($low as $product): ?><div class="list-row"><span><?php echo h($product['name']); ?></span><strong><?php echo (int) $product['stock']; ?> left</strong></div><?php endforeach; ?><?php if (!$low): ?><p class="muted">No low-stock products.</p><?php endif; ?>
            <?php endif; ?>
        </section>
    <?php else: ?>
        <section class="section narrow"><h1>Page not found</h1><a class="button" href="index.php">Back to shop</a></section>
    <?php endif; ?>
</main>
<footer class="site-footer"><a class="brand" href="index.php"><span class="brand-mark" aria-hidden="true">☕</span><span>Tasa</span></a><span>Filipino coffee, one cup at a time.</span><span>Demo checkout only · No real payment processing</span></footer>
</body>
</html>
