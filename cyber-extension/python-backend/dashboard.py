import streamlit as st
import pandas as pd
import requests
import time
from datetime import datetime, timedelta

# Configure the page
st.set_page_config(
    page_title="Cyber Extension Dashboard",
    page_icon="🛡️",
    layout="wide"
)

st.title("🛡️ Cybersecurity Extension Analytics Dashboard")

# Sidebar for controls
st.sidebar.header("Controls")
if st.sidebar.button('🔄 Refresh Data'):
    st.rerun()

# Fetch data from the Flask backend
API_URL = "http://127.0.0.1:5000/api/history"

def get_data():
    try:
        response = requests.get(API_URL)
        if response.status_code == 200:
            return response.json()
        else:
            st.error(f"Error fetching data: {response.status_code}")
            return []
    except requests.exceptions.ConnectionError:
        st.error("Could not connect to the backend. Is app.py running?")
        return []

history = get_data()

if not history:
    st.info("No analysis history available yet. Browse some websites to generate data!")
else:
    # Process data for metrics
    total_scanned = 0
    phishing_detected = 0
    legitimate_sites = 0
    
    table_data = []

    for entry in history:
        timestamp = datetime.fromtimestamp(entry.get('timestamp', time.time()))
        
        if entry.get('type') == 'batch':
            # Handle batch scan data (from background.js auto-scan)
            count = entry.get('total_scanned', 0)
            p_links = entry.get('phishing_links', [])
            p_count = len(p_links)
            
            total_scanned += count
            phishing_detected += p_count
            legitimate_sites += (count - p_count)
            
            # Add summary row
            table_data.append({
                "Time": timestamp,
                "URL": f"Batch Scan ({count} URLs)",
                "Result": f"{p_count} Phishing Found",
                "Confidence": "N/A",
                "Type": "Batch"
            })
            
        else:
            # Handle single URL scan data (from popup "Analyse URL")
            total_scanned += 1
            prediction = entry.get('prediction', 'Unknown')
            confidence = entry.get('confidence', 0)
            
            if "PHISHING" in prediction:
                phishing_detected += 1
            else:
                legitimate_sites += 1
                
            table_data.append({
                "Time": timestamp,
                "URL": entry.get('url'),
                "Result": prediction,
                "Confidence": f"{confidence:.2f}%" if isinstance(confidence, (int, float)) else str(confidence),
                "Type": "Single"
            })

    # Top Metrics
    col1, col2, col3 = st.columns(3)
    col1.metric("Total URLs Scanned", total_scanned)
    col2.metric("Phishing Detected", phishing_detected, delta_color="inverse")
    col3.metric("Legitimate Sites", legitimate_sites)

    # Create DataFrame
    df = pd.DataFrame(table_data)
    
    if not df.empty:
        # --- Threat Trends Graph ---
        st.divider()
        st.subheader("📈 Threat Trends Over Time")

        # 1. Prepare Data for Graph
        graph_data = []
        for entry in history:
            ts = datetime.fromtimestamp(entry.get('timestamp', time.time()))
            if entry.get('type') == 'batch':
                p_count = len(entry.get('phishing_links', []))
                total = entry.get('total_scanned', 0)
                l_count = total - p_count
                if p_count > 0:
                    graph_data.append({'Time': ts, 'Status': 'Phishing', 'Count': p_count})
                if l_count > 0:
                    graph_data.append({'Time': ts, 'Status': 'Legitimate', 'Count': l_count})
            else:
                prediction = entry.get('prediction', '')
                status = 'Phishing' if 'PHISHING' in prediction else 'Legitimate'
                graph_data.append({'Time': ts, 'Status': status, 'Count': 1})
        
        df_trends = pd.DataFrame(graph_data)

        if not df_trends.empty:
            # 2. Filters
            col_f1, col_f2 = st.columns(2)
            with col_f1:
                time_period = st.selectbox("Select Time Period", ["Last 24 Hours", "Last 7 Days", "Last 30 Days", "Custom Range"])
            with col_f2:
                selected_types = st.multiselect("Select Website Type", ["Phishing", "Legitimate"], default=["Phishing", "Legitimate"])

            # 3. Apply Filters
            now = datetime.now()
            freq = 'D' # Default frequency

            if time_period == "Last 24 Hours":
                start_date = now - timedelta(hours=24)
                df_trends = df_trends[df_trends['Time'] >= start_date]
                freq = 'h' # Hourly for 24h view
            elif time_period == "Last 7 Days":
                start_date = now - timedelta(days=7)
                df_trends = df_trends[df_trends['Time'] >= start_date]
            elif time_period == "Last 30 Days":
                start_date = now - timedelta(days=30)
                df_trends = df_trends[df_trends['Time'] >= start_date]
            elif time_period == "Custom Range":
                c1, c2 = st.columns(2)
                start_d = c1.date_input("Start Date", now - timedelta(days=7))
                end_d = c2.date_input("End Date", now)
                df_trends = df_trends[(df_trends['Time'].dt.date >= start_d) & (df_trends['Time'].dt.date <= end_d)]

            # 4. Plotting
            if not df_trends.empty and selected_types:
                df_trends = df_trends[df_trends['Status'].isin(selected_types)]
                # Group by Time (resampled) and Status
                df_chart = df_trends.set_index('Time').groupby([pd.Grouper(freq=freq), 'Status'])['Count'].sum().unstack(fill_value=0)
                st.line_chart(df_chart)
            else:
                st.info("No data available for the selected filters.")

        # Sort by time descending
        df = df.sort_values(by="Time", ascending=False)
        
        st.subheader("Recent Activity Log")
        st.dataframe(
            df[['Time', 'URL', 'Result', 'Confidence', 'Type']], 
            hide_index=True, 
            width='stretch'
        )
        
        # Charts
        st.subheader("Threat Distribution")
        chart_data = pd.DataFrame({
            'Status': ['Phishing', 'Legitimate'],
            'Count': [phishing_detected, legitimate_sites]
        })
        st.bar_chart(chart_data.set_index('Status'))
