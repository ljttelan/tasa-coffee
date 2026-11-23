CREATE TABLE IF NOT EXISTS users (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    name VARCHAR(120) NOT NULL,
    email VARCHAR(190) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role ENUM('customer', 'fulfillment', 'staff', 'admin') NOT NULL DEFAULT 'customer',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY users_email_unique (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS products (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    name VARCHAR(160) NOT NULL,
    category ENUM('Beans', 'Brewed', 'Pastries', 'Merch') NOT NULL,
    description TEXT NOT NULL,
    price DECIMAL(10, 2) UNSIGNED NOT NULL,
    stock INT UNSIGNED NOT NULL DEFAULT 0,
    image_url VARCHAR(2048) DEFAULT NULL,
    active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY products_active_category (active, category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS orders (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id BIGINT UNSIGNED NOT NULL,
    customer_name VARCHAR(120) NOT NULL,
    phone VARCHAR(50) NOT NULL,
    billing_address VARCHAR(500) NOT NULL,
    shipping_address VARCHAR(500) NOT NULL,
    payment_method ENUM('GCash (mock)', 'Card (mock)', 'Cash on delivery') NOT NULL,
    status ENUM('Pending', 'Packing', 'Out for delivery', 'Delivered', 'Cancelled', 'Returned') NOT NULL DEFAULT 'Pending',
    return_status ENUM('None', 'Requested', 'Approved', 'Rejected') NOT NULL DEFAULT 'None',
    subtotal DECIMAL(10, 2) UNSIGNED NOT NULL,
    delivery_fee DECIMAL(10, 2) UNSIGNED NOT NULL,
    total DECIMAL(10, 2) UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY orders_user_created (user_id, created_at),
    KEY orders_status_created (status, created_at),
    CONSTRAINT orders_user_fk FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS order_items (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    order_id BIGINT UNSIGNED NOT NULL,
    product_id BIGINT UNSIGNED DEFAULT NULL,
    product_name VARCHAR(160) NOT NULL,
    product_option VARCHAR(80) NOT NULL,
    quantity INT UNSIGNED NOT NULL,
    unit_price DECIMAL(10, 2) UNSIGNED NOT NULL,
    PRIMARY KEY (id),
    KEY order_items_order (order_id),
    CONSTRAINT order_items_order_fk FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE,
    CONSTRAINT order_items_product_fk FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO products (name, category, description, price, stock) VALUES
    ('Benguet Arabica Beans', 'Beans', 'Bright, nutty, medium roast.', 450.00, 30),
    ('Barako Dark Roast', 'Beans', 'Bold Batangas-style liberica.', 380.00, 40),
    ('Sagada Light Roast', 'Beans', 'Floral and citrusy.', 420.00, 25),
    ('Iced Spanish Latte', 'Brewed', 'Espresso, milk, and sweet cream.', 140.00, 99),
    ('Calamansi Cold Brew', 'Brewed', 'Cold brew with calamansi.', 130.00, 99),
    ('Ube Latte', 'Brewed', 'Ube and espresso.', 150.00, 99),
    ('Ensaymada', 'Pastries', 'Buttery, topped with cheese.', 85.00, 20),
    ('Tasa Tumbler', 'Merch', 'Insulated 450 ml tumbler.', 650.00, 12);
