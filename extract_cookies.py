import csv
from bs4 import BeautifulSoup
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.options import Options

def fetch_html_with_wait(url):
    """
    Fetches HTML from a URL using Selenium.
    Waits explicitly for the '.report-trow' elements to appear,
    ensuring the table is populated before scraping.
    """
    options = Options()
    options.add_argument("--headless")  # Run in background without opening a window
    
    driver = webdriver.Chrome(options=options)
    try:
        driver.get(url)
        
        # Custom wait condition: Wait until at least one row has text content.
        # This handles cases where rows exist but are initially empty.
        def rows_have_text(d):
            rows = d.find_elements(By.CSS_SELECTOR, ".report-tbody .report-trow")
            return any(row.text.strip() for row in rows)

        WebDriverWait(driver, 20).until(rows_have_text)
        return driver.page_source
    finally:
        driver.quit()

def extract_cookie_data(html_content, output_filename):
    """
    Parses HTML content to find the 'detailed-report' section
    and exports the cookie table to a CSV file.
    """
    soup = BeautifulSoup(html_content, 'html.parser')
    
    # 1. Find the specific container
    report_div = soup.find(id="detailed-report")
    
    if not report_div:
        print("Error: <div id='detailed-report'> was not found in the HTML.")
        return

    # 2. Locate the rows within the report body
    # Structure: .report-tbody -> .report-trow -> .report-tcol
    rows = report_div.select('.report-tbody .report-trow')
    
    extracted_data = []
    
    for row in rows:
        cols = row.find_all(class_='report-tcol')
        
        # Ensure we have enough columns (HTML has 5 cols)
        if len(cols) >= 5:
            cookie_name = cols[0].get_text(strip=True)
            domain = cols[1].get_text(strip=True)
            description = cols[2].get_text(strip=True)
            duration = cols[3].get_text(strip=True)
            cookie_type = cols[4].get_text(strip=True)
            
            # 3. Reorder for CSV: Cookie, Domain, Description, Type, Duration
            extracted_data.append([cookie_name, domain, description, cookie_type, duration])

    # 4. Write to CSV
    if extracted_data:
        with open(output_filename, 'w', newline='', encoding='utf-8') as f:
            writer = csv.writer(f)
            writer.writerow(['Cookies', 'Domain', 'Description', 'Type', 'Duration'])
            writer.writerows(extracted_data)
        print(f"Success! {len(extracted_data)} cookies saved to {output_filename}")
    else:
        print("Found the report section, but no cookie rows were extracted.")