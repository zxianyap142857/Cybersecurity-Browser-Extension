import time
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from webdriver_manager.chrome import ChromeDriverManager
import csv
from bs4 import BeautifulSoup
import pandas as pd

def get_detailed_report(html):
    soup = BeautifulSoup(html, 'html.parser')
    
    # Find the element with the specific ID
    report_section = soup.find(id="detailed-report")
    #print("Report Section:",report_section)
    
    if report_section:
        # Return the HTML string of the section
        return report_section.prettify()
    else:
        return "Detailed report section not found."

def clean_output(html):
    soup = BeautifulSoup(html, 'html.parser')
    
    # Locate the table body and rows
    report_section = soup.find(id="detailed-report")
    report_section.prettify()
    #print("Report Section: ",report_section)
    # The structure is div.report-tbody -> div.report-trow
    rows = soup.select('.report-tbody .report-trow')
    #rows = soup.select('.report-tbody .report-trow')
    
    extracted_data = []
    
    for row in rows:
        # Find all columns within the row
        cols = row.find_all(class_='report-tcol')
        
        if len(cols) == 5:
            # Extract text and strip whitespace
            cookie_name = cols[0].get_text(strip=True)
            domain = cols[1].get_text(strip=True)
            description = cols[2].get_text(strip=True)
            duration = cols[3].get_text(strip=True)
            cookie_type = cols[4].get_text(strip=True)
            
            # You requested the order: cookies, domain, description, type, duration
            # Note: In the HTML, Duration is index 3 and Type is index 4.
            # We swap them here to match your requested CSV format.
            extracted_data.append([cookie_name, domain, description, cookie_type, duration])

    return extracted_data
  


def rows_have_text(d):
  rows = d.find_elements(By.CSS_SELECTOR, ".report-tbody .report-trow")
  return any(row.text.strip() for row in rows)

def scrape_cookie_data(search_term):
    # Setup Chrome options (headless mode is optional but recommended for scraping)
    chrome_options = Options()
    #chrome_options.add_argument("--headless")  # Uncomment to run without opening a window
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")

    # Initialize the driver
    service = Service(ChromeDriverManager().install())
    driver = webdriver.Chrome(service=service, options=chrome_options)

    try:
        # 1. Navigate to the Cookie Serve website to search
        url = "https://www.cookieserve.com/"
        #print(f"Navigating to {url}...")
        driver.get(url)

        # 2. Find the search input and search
        wait = WebDriverWait(driver, 10)
        
        print(f"Searching for: {search_term}")
        search_box = wait.until(EC.element_to_be_clickable((By.CSS_SELECTOR, "input[type='text'], input[type='search']")))
        search_box.clear()
        search_box.send_keys(search_term)
        search_box.send_keys(Keys.RETURN)

        # 3. Wait for results and click the first result
        print("Waiting for results...")
        time.sleep(3)
        driver.execute_script("window.scrollBy(0, 1000);")
        time.sleep(5)
        '''
        WebDriverWait(driver, 20).until
        (
            EC.presence_of_element_located((By.CLASS_NAME, ".report-tbody .report-trow"))
        )
        '''
        WebDriverWait(driver, 25).until(rows_have_text)
        
        #time.sleep(15)
        #result_box = wait.until(EC.element_to_be_clickable((By.CLASS_NAME,"report-trow")))
        html= driver.page_source
        #print("HTML:",html)
        output=get_detailed_report(html)
        print("Output:",output)
        cleaned_data=clean_output(output)
        print("Cleaned Data:",cleaned_data)
        
        
    except Exception as e:
        print(f"An error occurred: {e}")
        # If the specific class isn't found, print the page source to debug
        # print(driver.page_source)

    finally:
        print("\nClosing driver...")
        driver.quit()


if __name__ == "__main__":
  #data=pd.read_csv('C:/Users/Yap Zheng Xian/Documents/Programming/Extension/notebook/legitimatewebsite.csv')
  #for item in data['input']:
    scrape_cookie_data("www.google.com")#insert current website url getting from the browser extension
